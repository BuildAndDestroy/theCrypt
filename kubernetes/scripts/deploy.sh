#!/usr/bin/env bash
# Fresh install / redeploy of The Crypt (MongoDB on NFS + site/chat/Tor Pod).
# Idempotent: re-running with unchanged config + secrets changes nothing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"
load_config

usage() {
  cat <<'USAGE'
Usage: kubernetes/scripts/deploy.sh

Prerequisites:
  - kubernetes/config.env           (cp kubernetes/config.example.env kubernetes/config.env)
  - kubernetes/secrets.local.env    (kubernetes/scripts/secrets.sh generate | pull)
  - images pushed                   (kubernetes/scripts/build-push.sh)
  - onion key: the onion-key Secret, or ONION_KEY_DIR (default tor/hidden_service/)

Steps: render manifests -> namespace + pull secret + onion-key -> mongo-auth +
chat-admin -> MongoDB (wait, verify app user) -> site Pod (wait) -> print onion.
USAGE
}
[[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && { usage; exit 0; }

load_secrets
"${SCRIPT_DIR}/render.sh"

# Pod template annotation: changes whenever a secret value changes, so pods
# restart and pick up new env (Secrets in env are read only at start).
SECRETS_HASH="$(sha256sum "$SECRETS_FILE" | cut -c1-16)"
patch_hash() {
  kubectl_cmd -n "$NAMESPACE" patch "$1" --type merge -p \
    "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"thecrypt.io/secrets-hash\":\"${SECRETS_HASH}\"}}}}}" >/dev/null
}

echo "== Namespace + pull secret + onion key"
kubectl_cmd get namespace "$NAMESPACE" >/dev/null 2>&1 || kubectl_cmd create namespace "$NAMESPACE"

if [[ -n "${REGISTRY_USERNAME:-}" && -n "${REGISTRY_PASSWORD:-}" ]]; then
  kubectl_cmd -n "$NAMESPACE" create secret docker-registry myregistrykey \
    --docker-server="${REGISTRY%%/*}" \
    --docker-username="$REGISTRY_USERNAME" --docker-password="$REGISTRY_PASSWORD" \
    --dry-run=client -o yaml | apply_stdin
elif ! secret_exists myregistrykey; then
  echo "Warning: no myregistrykey Secret and no REGISTRY_USERNAME/PASSWORD in config.env;" >&2
  echo "image pulls from a private registry will fail." >&2
fi

if secret_exists onion-key; then
  echo "onion-key Secret exists (keeping it)."
elif [[ -f "${ONION_KEY_DIR}/hs_ed25519_secret_key" ]]; then
  kubectl_cmd -n "$NAMESPACE" create secret generic onion-key \
    --from-file=hs_ed25519_secret_key="${ONION_KEY_DIR}/hs_ed25519_secret_key" \
    --from-file=hs_ed25519_public_key="${ONION_KEY_DIR}/hs_ed25519_public_key" \
    --from-file=hostname="${ONION_KEY_DIR}/hostname"
else
  echo "No onion-key Secret and no key in ${ONION_KEY_DIR}/ — generate one (README step 2)." >&2
  exit 1
fi

echo "== App secrets (mongo-auth, chat-admin)"
"${SCRIPT_DIR}/secrets.sh" apply

echo "== MongoDB"
kubectl_cmd apply -f "${RENDER_DIR}/mongodb.yaml"
kubectl_cmd -n "$NAMESPACE" wait --for=jsonpath='{.status.phase}'=Bound pvc/thecrypt-mongo --timeout=180s
patch_hash statefulset/thecrypt-mongo
echo "Waiting for MongoDB (first start on an empty volume runs the init scripts)..."
kubectl_cmd -n "$NAMESPACE" rollout status statefulset/thecrypt-mongo --timeout=600s

if ! "${SCRIPT_DIR}/verify-mongo-app-user.sh"; then
  "${SCRIPT_DIR}/mongo-bootstrap-app-user.sh"
  "${SCRIPT_DIR}/verify-mongo-app-user.sh"
fi

echo "== Site Pod (nginx + chat-api + tor)"
kubectl_cmd apply -f "${RENDER_DIR}/deployment-sidecar.yaml"
patch_hash deployment/thecrypt
kubectl_cmd -n "$NAMESPACE" rollout status deployment/thecrypt --timeout=300s

echo ""
echo "Deploy complete."
kubectl_cmd -n "$NAMESPACE" get pods
echo ""
echo "Onion: http://$(secret_value onion-key hostname)"
echo "Operator login: kubernetes/scripts/secrets.sh show-admin"
