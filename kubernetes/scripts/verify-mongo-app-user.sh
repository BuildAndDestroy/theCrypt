#!/usr/bin/env bash
# Check that the app user in mongo-auth can authenticate to MongoDB.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"
load_config

# Credentials are read from the pod's own env (mongo-auth), never passed in argv here.
# shellcheck disable=SC2016  # expanded inside the pod
if kubectl_cmd -n "$NAMESPACE" exec statefulset/thecrypt-mongo -c mongo -- sh -c \
  'mongosh --quiet -u "$MONGO_APP_USERNAME" -p "$MONGO_APP_PASSWORD" --authenticationDatabase thecrypt thecrypt \
     --eval "db.runCommand({connectionStatus:1}).authInfo.authenticatedUsers.length"' 2>/dev/null | grep -qx 1; then
  echo "App user OK: authenticates to the thecrypt database."
else
  echo "App user FAILED to authenticate." >&2
  exit 1
fi
