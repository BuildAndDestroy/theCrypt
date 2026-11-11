#!/usr/bin/env bash
# Upgrade a RUNNING pre-encryption install to field encryption at rest
# (AES-256-GCM for email / phone / message bodies, Argon2id passwords).
# Interactive: asks before every step; safe to stop and resume.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"
load_config

STEP_TITLES=(
  "Preflight checks"
  "Back up the database (plaintext!)"
  "Create the field-encryption key (DATA_KEY -> chat-data-key)"
  "Deploy the new chat-api with STRICT_ENCRYPTION=false"
  "Encrypt existing data (node src/migrate.js)"
  "Verify"
  "Switch to STRICT_ENCRYPTION=true and redeploy"
  "Wrap-up reminders"
)

usage() {
  cat <<'USAGE'
Usage: kubernetes/scripts/upgrade-encryption.sh [--from-step N]
       kubernetes/scripts/upgrade-encryption.sh --restore FILE

Upgrades a running pre-encryption install. Each step asks first; answer "n"
to stop, then resume later with --from-step N.

  1. Preflight: config.env + secrets.local.env present, cluster reachable,
     MongoDB and the site Pod running.
  2. Backup: mongodump (as MongoDB root, credentials read inside the pod) to
     kubernetes/backups/thecrypt-pre-encryption-<UTC>.archive.gz (mode 600).
     This backup is PLAINTEXT: store it securely, delete it once verified.
  3. secrets.sh add-data-key (skipped if DATA_KEY exists) + secrets.sh apply.
  4. STRICT_ENCRYPTION=false in config.env, new chat-api image pushed
     (build-push.sh chat-api, new CHAT_API_TAG), deploy.sh.
  5. migrate.js --dry-run, then the real run, then --check.
  6. Manual check (operator login) + automated spot check that stored
     message bodies / emails start with "v1:".
  7. STRICT_ENCRYPTION=true, deploy.sh, migrate.js --check.
  8. Reminders (Mongo TLS, delete the backup, NAS snapshots, Argon2).

Options:
  --from-step N    start at step N (step 1's read-only checks always run)
  --restore FILE   roll back: restore the step-2 backup over the thecrypt
                   database (mongorestore --drop, asks first)
  -h, --help       this help

Mongo TLS is a separate maintenance window: kubernetes/scripts/upgrade-mongo-tls.sh
USAGE
}

FROM=1
RESTORE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-step) FROM="${2:-}"; shift 2 ;;
    --restore) RESTORE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done
if ! [[ "$FROM" =~ ^[1-9][0-9]*$ ]] || (( FROM > ${#STEP_TITLES[@]} )); then
  echo "--from-step must be 1..${#STEP_TITLES[@]}" >&2
  exit 1
fi

stop_at() {
  echo ""
  echo "Stopped before step $1. Resume with: kubernetes/scripts/upgrade-encryption.sh --from-step $1"
  exit 1
}

# shellcheck disable=SC1090
file_data_key() { (set +u; source "$SECRETS_FILE"; printf %s "${DATA_KEY:-}"); }

pod_ready() {
  [[ "$(kubectl_cmd -n "$NAMESPACE" get "$1" -o jsonpath='{.status.readyReplicas}' 2>/dev/null)" == 1 ]]
}

# Run migrate.js in the chat-api container; output is shown live. Sets
# MIGRATE_JSON to the MIGRATE_RESULT payload; returns migrate.js's exit code.
MIGRATE_JSON=""
run_migrate() {
  local out rc
  out="$(mktemp)"
  echo "+ node src/migrate.js $*"
  set +e
  kubectl_cmd -n "$NAMESPACE" exec deployment/thecrypt -c chat-api -- node src/migrate.js "$@" 2>&1 | tee "$out"
  rc="${PIPESTATUS[0]}"
  set -e
  MIGRATE_JSON="$(sed -n 's/^MIGRATE_RESULT //p' "$out" | tail -n 1)"
  rm -f "$out"
  if [[ -z "$MIGRATE_JSON" ]]; then
    echo "migrate.js printed no MIGRATE_RESULT line. Is the encryption release of chat-api deployed?" >&2
    exit 1
  fi
  return "$rc"
}
# One numeric field of MIGRATE_JSON ("?" if absent).
mfield() {
  printf '%s' "$MIGRATE_JSON" | grep -oE "\"$1\"[[:space:]]*:[[:space:]]*[0-9]+" | grep -oE '[0-9]+$' || echo "?"
}
migrate_summary() {
  echo "  plaintext:  users=$(mfield usersPlain) messages=$(mfield messagesPlain)"
  echo "  encrypted:  users=$(mfield usersEncrypted) messages=$(mfield messagesEncrypted)"
  echo "  passwords:  scrypt=$(mfield scryptHashes) argon2id=$(mfield argon2Hashes)"
}

# ---------------------------------------------------------------- steps

step_1() {
  local ok=true
  [[ -f "$CONFIG_FILE" ]] || { echo "Missing $CONFIG_FILE" >&2; ok=false; }
  if [[ ! -f "$SECRETS_FILE" ]]; then
    echo "Missing $SECRETS_FILE — run: kubernetes/scripts/secrets.sh pull" >&2
    ok=false
  fi
  if ! kubectl_cmd -n "$NAMESPACE" get pods >/dev/null; then
    echo "Cannot reach the cluster / namespace ${NAMESPACE}." >&2
    ok=false
  else
    pod_ready statefulset/thecrypt-mongo || { echo "MongoDB (statefulset/thecrypt-mongo) is not ready." >&2; ok=false; }
    pod_ready deployment/thecrypt || { echo "The site Pod (deployment/thecrypt) is not ready." >&2; ok=false; }
  fi
  [[ "$ok" == true ]] || exit 1

  local in_file=no in_cluster=no
  [[ -n "$(file_data_key)" ]] && in_file=yes
  secret_exists chat-data-key && in_cluster=yes
  if [[ "$in_cluster" == yes && "$in_file" == no ]]; then
    echo "chat-data-key exists in the cluster but DATA_KEY is not in your secrets file." >&2
    echo "Run kubernetes/scripts/secrets.sh pull first (never generate a second key)." >&2
    exit 1
  fi
  kubectl_cmd -n "$NAMESPACE" get pods
  echo ""
  echo "Namespace:          ${NAMESPACE}"
  echo "chat-api image:     ${REGISTRY}/thecrypt-chat-api:${CHAT_API_TAG}"
  echo "STRICT_ENCRYPTION:  ${STRICT_ENCRYPTION}   MONGO_TLS_MODE: ${MONGO_TLS_MODE}   MONGO_TLS: ${MONGO_TLS}"
  echo "DATA_KEY in file:   ${in_file}   chat-data-key in cluster: ${in_cluster}"
  echo "Preflight OK."
}

step_2() {
  local ts out size
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  umask 077
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  out="${BACKUP_DIR}/thecrypt-pre-encryption-${ts}.archive.gz"
  echo "Dumping to $out ..."
  # As MongoDB root; credentials never leave the pod (see lib.sh).
  if ! mongo_tool_pod mongodump --archive --gzip > "$out"; then
    echo "mongodump FAILED; partial file left at $out (delete it)." >&2
    exit 1
  fi
  chmod 600 "$out"
  size="$(stat -c %s "$out")"
  if (( size == 0 )) || ! gzip -t "$out" 2>/dev/null; then
    echo "Backup is empty or not a valid gzip archive: $out" >&2
    exit 1
  fi
  echo ""
  echo "Backup OK: $out ($size bytes, mode 600)"
  echo "Roll back to it if needed: kubernetes/scripts/upgrade-encryption.sh --restore $out"
  echo ""
  echo "!!! THIS BACKUP IS PLAINTEXT: every email, phone number and chat message,"
  echo "!!! unencrypted. Keep it off shared storage, never commit it, and DELETE it"
  echo "!!! (shred -u) once the upgrade is verified (step 8 reminds you)."
}

step_3() {
  if [[ -n "$(file_data_key)" ]]; then
    echo "DATA_KEY already in $SECRETS_FILE (keeping it)."
  else
    "${SCRIPT_DIR}/secrets.sh" add-data-key
  fi
  "${SCRIPT_DIR}/secrets.sh" apply
  echo ""
  echo "!!! Back up $SECRETS_FILE NOW (it holds DATA_KEY), somewhere other than"
  echo "!!! your database backups. Without DATA_KEY the encrypted data is gone."
  confirm "Backed up?" || echo "Do it before step 5 — that is when data gets encrypted."
}

step_4() {
  load_config
  if [[ "$STRICT_ENCRYPTION" != false ]]; then
    echo "STRICT_ENCRYPTION must be false while plaintext rows still exist, or the"
    echo "new chat-api refuses them."
    if confirm "Set STRICT_ENCRYPTION=false in $CONFIG_FILE now?"; then
      config_set STRICT_ENCRYPTION false
    else
      echo "Set STRICT_ENCRYPTION=false in config.env yourself, then resume." >&2
      stop_at 4
    fi
  fi
  echo "The encryption release of chat-api (Node 24) must be pushed as:"
  echo "  ${REGISTRY}/thecrypt-chat-api:${CHAT_API_TAG}"
  echo "Bump CHAT_API_TAG in config.env if needed, then: kubernetes/scripts/build-push.sh chat-api"
  confirm "Is that image pushed?" || stop_at 4
  "${SCRIPT_DIR}/deploy.sh"
  if ! kubectl_cmd -n "$NAMESPACE" exec deployment/thecrypt -c chat-api -- test -f src/migrate.js; then
    echo "The running chat-api has no src/migrate.js — wrong image/tag deployed?" >&2
    exit 1
  fi
}

step_5() {
  run_migrate --dry-run || true
  echo ""
  echo "Dry run:"
  migrate_summary
  confirm "Encrypt these rows now?" || stop_at 5
  run_migrate || { echo "migrate.js failed (it is idempotent: fix and re-run step 5)." >&2; exit 1; }
  echo ""
  if run_migrate --check; then
    echo ""
    echo "Check OK: no plaintext left."
    migrate_summary
  else
    echo ""
    migrate_summary
    echo "Plaintext remains. Re-run step 5 (--from-step 5); see chat-api logs if it persists." >&2
    exit 1
  fi
}

step_6() {
  echo "Manual check: open http://<onion>/admin/ in Tor Browser, log in as the"
  echo "operator, open a conversation and confirm old and new messages read normally."
  confirm "Operator login + conversation look right?" || stop_at 6
  echo ""
  echo "Spot check of what MongoDB stores (as root; credentials read inside the pod):"
  local js out
  # shellcheck disable=SC2016
  js='const fs=require("fs");const r=k=>fs.readFileSync("/run/secrets/mongo/"+k,"utf8").replace(/\r?\n$/,"");
db.getSiblingDB("admin").auth(r("root_username"),r("root_password"));
const d=db.getSiblingDB("thecrypt");
const plain=(c,f)=>d.getCollection(c).countDocuments({[f]:{$type:"string",$not:/^v1:/}});
const enc=(c,f)=>d.getCollection(c).countDocuments({[f]:{$regex:/^v1:/}});
const m=d.messages.findOne({body:{$type:"string"}},{body:1});
const u=d.users.findOne({email:{$type:"string"}},{email:1});
print("  sample message.body starts with: "+(m?JSON.stringify(m.body.slice(0,3)):"(no messages)"));
print("  sample user.email   starts with: "+(u?JSON.stringify(u.email.slice(0,3)):"(no users)"));
print("SPOTCHECK "+JSON.stringify({plain:plain("messages","body")+plain("users","email")+plain("users","phone"),
  messagesEncrypted:enc("messages","body"),emailsEncrypted:enc("users","email")}));'
  out="$(mongosh_pod --eval "$js")"
  printf '%s\n' "$out" | grep -v '^SPOTCHECK '
  out="$(printf '%s\n' "$out" | sed -n 's/^SPOTCHECK //p')"
  echo "  $out"
  if ! printf '%s' "$out" | grep -q '"plain":0[,}]'; then
    echo "Plaintext email/phone/body values found in MongoDB. Re-run step 5." >&2
    exit 1
  fi
  echo "Spot check OK: stored values are ciphertext (v1:...)."
}

step_7() {
  load_config
  if [[ "$STRICT_ENCRYPTION" != true ]]; then
    if confirm "Set STRICT_ENCRYPTION=true in $CONFIG_FILE now?"; then
      config_set STRICT_ENCRYPTION true
    else
      echo "Set STRICT_ENCRYPTION=true in config.env yourself, then resume." >&2
      stop_at 7
    fi
  fi
  "${SCRIPT_DIR}/deploy.sh"
  if run_migrate --check; then
    echo "Strict mode on; check OK."
  else
    echo "--check reports plaintext after strict mode. Investigate before going further." >&2
    exit 1
  fi
}

step_8() {
  if [[ -z "$MIGRATE_JSON" ]]; then run_migrate --check >/dev/null || true; fi
  local backups
  backups="$(find "$BACKUP_DIR" -maxdepth 1 -name 'thecrypt-pre-encryption-*' 2>/dev/null || true)"
  cat <<EOF
Upgrade done. Remaining:

 * PLAINTEXT BACKUP — once you are satisfied, delete it:
$(if [[ -n "$backups" ]]; then printf '%s\n' "$backups" | sed 's/^/     shred -u /'; else echo "     (none in ${BACKUP_DIR}/)"; fi)
 * NAS SNAPSHOTS of the MongoDB share taken before today still hold plaintext;
   prune them (and any other copies of the old database).
 * DATA_KEY: confirm secrets.local.env is backed up, apart from DB backups.
 * PASSWORDS: $(mfield scryptHashes) account(s) still have scrypt hashes; each upgrades
   to Argon2id on that user's next successful login. Nothing to do.
 * MONGO TLS (in-cluster traffic) is a separate window:
     kubernetes/scripts/upgrade-mongo-tls.sh
EOF
}

# Roll back to a step-2 backup (pre-encryption plaintext).
restore_backup() {
  [[ -s "$1" ]] || { echo "No such backup (or empty): $1" >&2; exit 1; }
  gzip -t "$1" || { echo "Not a valid gzip archive: $1" >&2; exit 1; }
  echo "This DROPS every collection in the thecrypt database and restores them"
  echo "from $1."
  echo "The backup is plaintext: run chat-api with STRICT_ENCRYPTION=false"
  echo "(config.env + deploy.sh) afterwards, or roll chat-api back to the old"
  echo "image, then encrypt again from step 5."
  confirm "Restore now?" || exit 1
  mongo_tool_pod -i mongorestore --nsInclude 'thecrypt.*' --drop --archive --gzip < "$1"
  echo "Restored."
}

# ---------------------------------------------------------------- main

if [[ -n "$RESTORE" ]]; then
  restore_backup "$RESTORE"
  exit 0
fi

if (( FROM > 1 )); then
  echo "== Preflight (read-only)"
  step_1
fi
for (( n = FROM; n <= ${#STEP_TITLES[@]}; n++ )); do
  echo ""
  echo "== Step ${n}/${#STEP_TITLES[@]}: ${STEP_TITLES[n-1]}"
  confirm "Run step ${n}?" || stop_at "$n"
  "step_${n}"
done
