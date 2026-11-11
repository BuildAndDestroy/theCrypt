#!/usr/bin/env bash
# Check that the app user in mongo-auth can authenticate to MongoDB.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"
load_config

# Credentials are read inside the pod from the mounted mongo-auth files, so
# they never appear in any command line.
JS='const fs=require("fs");const r=k=>fs.readFileSync("/run/secrets/mongo/"+k,"utf8").replace(/\r?\n$/,"");
const d=db.getSiblingDB("thecrypt");d.auth(r("app_username"),r("app_password"));
print(d.runCommand({connectionStatus:1}).authInfo.authenticatedUsers.length)'

# mongosh_pod (lib.sh) uses TLS when the mongo-tls Secret is mounted.
if mongosh_pod --eval "$JS" 2>/dev/null | grep -qx 1; then
  echo "App user OK: authenticates to the thecrypt database."
else
  echo "App user FAILED to authenticate." >&2
  exit 1
fi
