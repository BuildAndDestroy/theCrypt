#!/usr/bin/env bash
# Render the manifests with config.env values into kubernetes/.rendered/
# (gitignored). deploy.sh calls this; run it alone to review what will apply.
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

node_sel='s#^\(\s*\)thecrypt.io/mongo: "true".*#&#'
[[ -n "$MONGO_NODE" ]] && node_sel="s#^\(\s*\)thecrypt.io/mongo: \"true\".*#\1kubernetes.io/hostname: ${MONGO_NODE}#"

sed -e "s#server: NFS_SERVER#server: ${MONGO_NFS_SERVER}#" \
    -e "s#path: NFS_PATH#path: ${MONGO_NFS_PATH}#" \
    -e "$node_sel" \
    -e "s#namespace: tor-hidden-ns#namespace: ${NAMESPACE}#" \
    "${K8S_ROOT}/mongodb.yaml" > "${RENDER_DIR}/mongodb.yaml"

sed -E -e "s#registry\.yourregistry\.com/thecrypt-website:[^[:space:]]+#${REGISTRY}/thecrypt-website:${WEBSITE_TAG}#" \
       -e "s#registry\.yourregistry\.com/thecrypt-chat-api:[^[:space:]]+#${REGISTRY}/thecrypt-chat-api:${CHAT_API_TAG}#" \
       -e "s#registry\.yourregistry\.com/thecrypt-tor:[^[:space:]]+#${REGISTRY}/thecrypt-tor:${TOR_TAG}#" \
       -e "s#namespace: tor-hidden-ns#namespace: ${NAMESPACE}#" \
       -e "s#^(  name: )tor-hidden-ns\$#\1${NAMESPACE}#" \
       -e "s#thecrypt-mongo\.tor-hidden-ns\.svc#thecrypt-mongo.${NAMESPACE}.svc#" \
       "${K8S_ROOT}/deployment-sidecar.yaml" > "${RENDER_DIR}/deployment-sidecar.yaml"

# Fail loudly if a placeholder survived.
if grep -nE 'NFS_SERVER|NFS_PATH|registry\.yourregistry\.com' "${RENDER_DIR}"/*.yaml | grep -v '^\S*:[0-9]*:\s*#'; then
  echo "Unrendered placeholder(s) above." >&2
  exit 1
fi
echo "Rendered into ${RENDER_DIR}/"
