#!/usr/bin/env bash
# Shared helpers for kubernetes/scripts/*.sh
set -euo pipefail

K8S_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${K8S_ROOT}/.." && pwd)"
CONFIG_FILE="${K8S_ROOT}/config.env"
SECRETS_FILE="${K8S_ROOT}/secrets.local.env"
# shellcheck disable=SC2034  # used by the scripts that source this
RENDER_DIR="${K8S_ROOT}/.rendered"

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

confirm() {
  local reply
  read -r -p "$1 [y/N] " reply
  [[ "${reply,,}" == "y" || "${reply,,}" == "yes" ]]
}
