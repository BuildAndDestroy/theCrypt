#!/usr/bin/env bash
# Re-run the first-boot init script as root (idempotent): creates the app user,
# or resets its password to the current mongo-auth app_password.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"
load_config

# Root credentials are read inside the pod from the mounted mongo-auth files.
JS='const fs=require("fs");const r=k=>fs.readFileSync("/run/secrets/mongo/"+k,"utf8").replace(/\r?\n$/,"");
db.getSiblingDB("admin").auth(r("root_username"),r("root_password"));
load("/docker-entrypoint-initdb.d/init-app-user.js")'

echo "Bootstrapping app user from mongo-auth on the mongo pod..."
mongosh_pod --eval "$JS"   # TLS-aware; see lib.sh
