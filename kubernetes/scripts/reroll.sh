#!/usr/bin/env bash
# Restart MongoDB and the site after an outage (e.g. NAS or power loss).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"
load_config

FRESH=false
usage() {
  cat <<'USAGE'
Usage: kubernetes/scripts/reroll.sh [--fresh-mongo]

  (default)       Soft reroll: restart MongoDB, then the site Pod. Use when the
                  NFS share is healthy and mongo logs show no corruption.
  --fresh-mongo   Wipe and rebuild the database. Only after WiredTiger
                  corruption ("read checksum error", "potential hardware
                  corruption" in mongo logs). DESTROYS all accounts, keys and
                  chat logs. The onion address and operator login are kept.

Verify afterwards:
  kubectl -n tor-hidden-ns get pods
  kubectl -n tor-hidden-ns logs statefulset/thecrypt-mongo --tail=50
  kubectl -n tor-hidden-ns logs deployment/thecrypt -c chat-api --tail=50
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fresh-mongo) FRESH=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ "$FRESH" == true ]]; then
  echo "FRESH MONGO: this deletes every account, access key and chat log."
  confirm "Continue?" || { echo "Aborted; nothing changed."; exit 1; }
  "${SCRIPT_DIR}/undeploy.sh" --delete-pvc --yes
  echo ""
  echo "Now delete ALL files inside the NFS export on your NAS:"
  echo "  ${MONGO_NFS_SERVER:-<MONGO_NFS_SERVER>}:${MONGO_NFS_PATH:-<MONGO_NFS_PATH>}"
  confirm "NFS folder cleared?" || { echo "Stopped. Clear it, then run: kubernetes/scripts/deploy.sh"; exit 1; }
  "${SCRIPT_DIR}/deploy.sh"
  echo "Fresh database deployed. The operator account is recreated from chat-admin;"
  echo "issue new customer keys."
  exit 0
fi

echo "Soft reroll: restarting MongoDB..."
kubectl_cmd -n "$NAMESPACE" rollout restart statefulset/thecrypt-mongo
kubectl_cmd -n "$NAMESPACE" rollout status statefulset/thecrypt-mongo --timeout=600s
"${SCRIPT_DIR}/verify-mongo-app-user.sh"

echo "Soft reroll: restarting the site Pod..."
kubectl_cmd -n "$NAMESPACE" rollout restart deployment/thecrypt
kubectl_cmd -n "$NAMESPACE" rollout status deployment/thecrypt --timeout=300s

echo ""
echo "Reroll complete."
kubectl_cmd -n "$NAMESPACE" get pods
