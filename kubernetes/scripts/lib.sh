#!/usr/bin/env bash
# Shared helpers for kubernetes/scripts/*.sh
set -euo pipefail

K8S_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${K8S_ROOT}/.." && pwd)"
CONFIG_FILE="${K8S_ROOT}/config.env"
SECRETS_FILE="${K8S_ROOT}/secrets.local.env"
# shellcheck disable=SC2034  # used by the scripts that source this
RENDER_DIR="${K8S_ROOT}/.rendered"
# Mongo TLS material (CA + server cert), gitignored. See mongo-tls.sh.
# shellcheck disable=SC2034
TLS_DIR="${K8S_ROOT}/mongo-tls"
# Local database backups (plaintext before encryption!), gitignored.
# shellcheck disable=SC2034
BACKUP_DIR="${K8S_ROOT}/backups"

load_config() {
  if [[ -f "$CONFIG_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$CONFIG_FILE"
    set +a
  fi
  NAMESPACE="${NAMESPACE:-tor-hidden-ns}"
  MONGO_NFS_SERVER="${MONGO_NFS_SERVER:-}"
  MONGO_NFS_PATH="${MONGO_NFS_PATH:-}"
  MONGO_NODE="${MONGO_NODE:-}"
  REGISTRY="${REGISTRY:-registry.yourregistry.com}"
  WEBSITE_TAG="${WEBSITE_TAG:-1.0.0}"
  CHAT_API_TAG="${CHAT_API_TAG:-1.0.0}"
  TOR_TAG="${TOR_TAG:-1.0.0}"
  PLATFORM="${PLATFORM:-linux/arm64}"
  BUILDX_BUILDER="${BUILDX_BUILDER:-}"
  ONION_KEY_DIR="${ONION_KEY_DIR:-tor/hidden_service}"
  [[ "$ONION_KEY_DIR" = /* ]] || ONION_KEY_DIR="${REPO_ROOT}/${ONION_KEY_DIR}"
  # Field encryption: false only while upgrading a pre-encryption database.
  STRICT_ENCRYPTION="${STRICT_ENCRYPTION:-true}"
  # mongod TLS: disabled | allowTLS | preferTLS | requireTLS
  MONGO_TLS_MODE="${MONGO_TLS_MODE:-disabled}"
  # chat-api -> MongoDB over TLS (needs MONGO_TLS_MODE != disabled).
  MONGO_TLS="${MONGO_TLS:-false}"

  case "$STRICT_ENCRYPTION" in true|false) ;; *)
    echo "config.env: STRICT_ENCRYPTION must be true or false (got '$STRICT_ENCRYPTION')" >&2; exit 1 ;;
  esac
  case "$MONGO_TLS_MODE" in disabled|allowTLS|preferTLS|requireTLS) ;; *)
    echo "config.env: MONGO_TLS_MODE must be disabled|allowTLS|preferTLS|requireTLS (got '$MONGO_TLS_MODE')" >&2; exit 1 ;;
  esac
  case "$MONGO_TLS" in true|false) ;; *)
    echo "config.env: MONGO_TLS must be true or false (got '$MONGO_TLS')" >&2; exit 1 ;;
  esac
  if [[ "$MONGO_TLS" == true && "$MONGO_TLS_MODE" == disabled ]]; then
    echo "config.env: MONGO_TLS=true needs MONGO_TLS_MODE other than disabled." >&2
    exit 1
  fi
}

# Set KEY=VALUE in config.env (replace the line, or append it).
config_set() {
  local key="$1" val="$2"
  [[ -f "$CONFIG_FILE" ]] || { echo "Missing $CONFIG_FILE" >&2; exit 1; }
  if grep -qE "^${key}=" "$CONFIG_FILE"; then
    sed -i "s#^${key}=.*#${key}=${val}#" "$CONFIG_FILE"
  else
    printf '\n%s=%s\n' "$key" "$val" >> "$CONFIG_FILE"
  fi
  printf -v "$key" '%s' "$val"
  echo "config.env: ${key}=${val}"
}

load_secrets() {
  if [[ ! -f "$SECRETS_FILE" ]]; then
    echo "Missing $SECRETS_FILE" >&2
    echo "  New install:        kubernetes/scripts/secrets.sh generate" >&2
    echo "  Existing cluster:   kubernetes/scripts/secrets.sh pull" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  source "$SECRETS_FILE"
  set +a
  if [[ -z "${DATA_KEY:-}" ]]; then
    echo "DATA_KEY is missing from $SECRETS_FILE (the field-encryption master key)." >&2
    echo "  Existing install, key already in the cluster:  kubernetes/scripts/secrets.sh pull" >&2
    echo "  Upgrading from a pre-encryption release:       kubernetes/scripts/upgrade-encryption.sh" >&2
    exit 1
  fi
}

kubectl_cmd() {
  if command -v kubectl >/dev/null 2>&1; then
    kubectl "$@"
  elif command -v k3s >/dev/null 2>&1; then
    sudo k3s kubectl "$@"
  else
    echo "kubectl or k3s not found" >&2
    exit 1
  fi
}

# kubectl create secret ... --dry-run | kubectl apply: create-or-update.
apply_stdin() { kubectl_cmd apply -f -; }

secret_exists() { kubectl_cmd -n "$NAMESPACE" get secret "$1" >/dev/null 2>&1; }

# Read one key of a Secret (decoded) to stdout.
secret_value() {
  kubectl_cmd -n "$NAMESPACE" get secret "$1" -o "jsonpath={.data.$2}" | base64 -d
}

# Run mongosh in the mongo container. When the mongo-tls Secret is mounted it
# connects over TLS (verifying the server cert; SAN includes 127.0.0.1), which
# works in every MONGO_TLS_MODE except disabled; otherwise plain. Extra args
# (e.g. --eval JS) are passed through; never put credentials in them.
mongosh_pod() {
  # shellcheck disable=SC2016  # expanded by sh inside the pod
  kubectl_cmd -n "$NAMESPACE" exec statefulset/thecrypt-mongo -c mongo -- sh -c '
ca=/run/secrets/mongo-tls/ca.crt
if [ -f "$ca" ]; then set -- --tls --tlsCAFile "$ca" "$@"; fi
exec mongosh --quiet --norc --host 127.0.0.1 "$@"' mongosh "$@"
}

# Run mongodump / mongorestore in the mongo container as MongoDB root:
#   mongo_tool_pod [-i] <mongodump|mongorestore> [args...]
# -i forwards stdin (for mongorestore --archive). Credentials are read from the
# mounted mongo-auth files inside the pod; the password goes into a mode-600
# --config file on the pod's /tmp emptyDir (removed on exit), so it is never in
# any argv, here or in the pod. TLS is used when mongo-tls is mounted.
read -r -d '' MONGO_TOOL_SH <<'SH' || true
set -eu
umask 077
tool="$1"; shift
cfg="$(mktemp /tmp/mongotool.XXXXXX)"
trap 'rm -f "$cfg"' EXIT
printf "password: '%s'\n" "$(sed "s/'/''/g" /run/secrets/mongo/root_password)" > "$cfg"
set -- "$@" --config "$cfg" --username "$(cat /run/secrets/mongo/root_username)" \
  --authenticationDatabase admin --host 127.0.0.1
ca=/run/secrets/mongo-tls/ca.crt
if [ -f "$ca" ]; then set -- "$@" --ssl --sslCAFile "$ca"; fi
"$tool" "$@"
SH
mongo_tool_pod() {
  local stdin=()
  [[ "${1:-}" == -i ]] && { stdin=(-i); shift; }
  kubectl_cmd -n "$NAMESPACE" exec "${stdin[@]}" statefulset/thecrypt-mongo -c mongo -- \
    sh -c "$MONGO_TOOL_SH" sh "$@"
}

confirm() {
  local reply
  read -r -p "$1 [y/N] " reply
  [[ "${reply,,}" == "y" || "${reply,,}" == "yes" ]]
}
