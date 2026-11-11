#!/usr/bin/env bash
# Render the manifests with config.env values into kubernetes/.rendered/
# (gitignored). deploy.sh calls this; run it alone to review what will apply.
#
# Conditional blocks: lines between "# TLS-BEGIN" and "# TLS-END" (each alone
# on its line) are kept, minus the markers, or dropped:
#   mongodb.yaml             kept when MONGO_TLS_MODE != disabled
#   deployment-sidecar.yaml  kept when MONGO_TLS=true
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"
load_config

if [[ -z "$MONGO_NFS_SERVER" || -z "$MONGO_NFS_PATH" ]]; then
  echo "Set MONGO_NFS_SERVER and MONGO_NFS_PATH in kubernetes/config.env" >&2
  exit 1
fi

mkdir -p "$RENDER_DIR"

# stdin -> stdout; $1 = true keeps the TLS blocks, anything else drops them.
tls_blocks() {
  if [[ "$1" == true ]]; then
    sed -e '/^[[:space:]]*# TLS-BEGIN[[:space:]]*$/d' -e '/^[[:space:]]*# TLS-END[[:space:]]*$/d'
  else
    sed -e '/^[[:space:]]*# TLS-BEGIN[[:space:]]*$/,/^[[:space:]]*# TLS-END[[:space:]]*$/d'
  fi
}
mongod_tls=false
[[ "$MONGO_TLS_MODE" != disabled ]] && mongod_tls=true

node_sel='s#^\(\s*\)thecrypt.io/mongo: "true".*#&#'
[[ -n "$MONGO_NODE" ]] && node_sel="s#^\(\s*\)thecrypt.io/mongo: \"true\".*#\1kubernetes.io/hostname: ${MONGO_NODE}#"

sed -e "s#server: NFS_SERVER#server: ${MONGO_NFS_SERVER}#" \
    -e "s#path: NFS_PATH#path: ${MONGO_NFS_PATH}#" \
    -e "$node_sel" \
    -e "s#namespace: tor-hidden-ns#namespace: ${NAMESPACE}#" \
    -e "/^[[:space:]]*- --tlsMode[[:space:]]*\$/{n;s#^\([[:space:]]*- \)[A-Za-z]*#\1${MONGO_TLS_MODE}#}" \
    "${K8S_ROOT}/mongodb.yaml" | tls_blocks "$mongod_tls" > "${RENDER_DIR}/mongodb.yaml"

sed -E -e "s#registry\.yourregistry\.com/thecrypt-website:[^[:space:]]+#${REGISTRY}/thecrypt-website:${WEBSITE_TAG}#" \
       -e "s#registry\.yourregistry\.com/thecrypt-chat-api:[^[:space:]]+#${REGISTRY}/thecrypt-chat-api:${CHAT_API_TAG}#" \
       -e "s#registry\.yourregistry\.com/thecrypt-tor:[^[:space:]]+#${REGISTRY}/thecrypt-tor:${TOR_TAG}#" \
       -e "s#namespace: tor-hidden-ns#namespace: ${NAMESPACE}#" \
       -e "s#^(  name: )tor-hidden-ns\$#\1${NAMESPACE}#" \
       -e "s#thecrypt-mongo\.tor-hidden-ns\.svc#thecrypt-mongo.${NAMESPACE}.svc#" \
       -e "/^[[:space:]]*- name: STRICT_ENCRYPTION[[:space:]]*\$/{n;s#value: \"[a-z]*\"#value: \"${STRICT_ENCRYPTION}\"#}" \
       -e "/^[[:space:]]*- name: MONGO_TLS[[:space:]]*\$/{n;s#value: \"[a-z]*\"#value: \"${MONGO_TLS}\"#}" \
       "${K8S_ROOT}/deployment-sidecar.yaml" | tls_blocks "$MONGO_TLS" > "${RENDER_DIR}/deployment-sidecar.yaml"

# Fail loudly if a placeholder survived.
if grep -nE 'NFS_SERVER|NFS_PATH|registry\.yourregistry\.com' "${RENDER_DIR}"/*.yaml | grep -v '^\S*:[0-9]*:\s*#'; then
  echo "Unrendered placeholder(s) above." >&2
  exit 1
fi
if grep -nE '^[[:space:]]*# TLS-(BEGIN|END)[[:space:]]*$' "${RENDER_DIR}"/*.yaml; then
  echo "Unbalanced TLS-BEGIN/TLS-END marker(s) above." >&2
  exit 1
fi
# The config values must have landed (guards against a manifest edit that
# moves the lines the seds above key on).
check_value() {
  grep -A1 -E -- "^[[:space:]]*- $2[[:space:]]*\$" "${RENDER_DIR}/$1" | grep -qE -- "$3" || {
    echo "render.sh: $2 not set to the config.env value in $1" >&2; exit 1; }
}
check_value deployment-sidecar.yaml "name: STRICT_ENCRYPTION" "value: \"${STRICT_ENCRYPTION}\""
check_value deployment-sidecar.yaml "name: MONGO_TLS" "value: \"${MONGO_TLS}\""
[[ "$mongod_tls" == true ]] && check_value mongodb.yaml "--tlsMode" "- ${MONGO_TLS_MODE}([[:space:]]|\$)"
echo "Rendered into ${RENDER_DIR}/ (MONGO_TLS_MODE=${MONGO_TLS_MODE}, MONGO_TLS=${MONGO_TLS}, STRICT_ENCRYPTION=${STRICT_ENCRYPTION})"
