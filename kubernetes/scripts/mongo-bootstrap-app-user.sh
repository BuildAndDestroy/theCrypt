#!/usr/bin/env bash
# Re-run the first-boot init script as root (idempotent): creates the app user,
# or resets its password to the current mongo-auth app_password.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"
load_config

echo "Bootstrapping app user from mongo-auth on the mongo pod..."
# shellcheck disable=SC2016  # expanded inside the pod
kubectl_cmd -n "$NAMESPACE" exec statefulset/thecrypt-mongo -c mongo -- sh -c \
  'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin \
     /docker-entrypoint-initdb.d/init-app-user.js'
