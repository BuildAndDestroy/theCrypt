#!/usr/bin/env bash
# Remove The Crypt workloads. Secrets (onion key, mongo-auth, chat-admin) and the
# namespace are kept, so deploy.sh brings back the same onion address and data.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"
load_config

DELETE_PVC=false
YES=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --delete-pvc) DELETE_PVC=true; shift ;;
    -y|--yes) YES=true; shift ;;
    -h|--help)
      cat <<'USAGE'
Usage: kubernetes/scripts/undeploy.sh [--delete-pvc] [-y]

  (default)      delete the site Deployment, MongoDB StatefulSet, Services,
                 NetworkPolicies and ConfigMaps
  --delete-pvc   also delete the PVC + PV objects. The PV is Retain, so the
                 files on the NFS share are NOT deleted — clear them on the NAS
                 if you want a fresh database.
  -y, --yes      don't ask for confirmation
USAGE
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ "$YES" != true ]]; then
  confirm "Take The Crypt offline in namespace ${NAMESPACE}?" || exit 1
fi

k() { kubectl_cmd -n "$NAMESPACE" "$@"; }
k delete deployment thecrypt --ignore-not-found
k delete statefulset thecrypt-mongo --ignore-not-found
k delete service thecrypt-mongo --ignore-not-found
k delete networkpolicy thecrypt thecrypt-mongo --ignore-not-found
k delete configmap torrc thecrypt-mongo-init --ignore-not-found
k wait --for=delete pod -l app=thecrypt-mongo --timeout=120s 2>/dev/null || true

if [[ "$DELETE_PVC" == true ]]; then
  k delete pvc thecrypt-mongo --ignore-not-found --wait=true
  kubectl_cmd delete pv thecrypt-mongo-nfs-pv --ignore-not-found
fi

echo "Undeploy complete (Secrets and namespace kept)."
k get all 2>/dev/null || true
