#!/usr/bin/env bash
# Turn on TLS between chat-api and MongoDB on a RUNNING install, in stages so
# nothing is ever unable to connect. Interactive: asks before every step; safe
# to stop and resume. Each MongoDB restart is a short chat outage.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"
load_config

STEP_TITLES=(
  "Preflight checks"
  "Certificates (mongo-tls.sh generate + apply)"
  "MongoDB accepts TLS (MONGO_TLS_MODE=preferTLS, restarts MongoDB)"
  "chat-api connects over TLS (MONGO_TLS=true, restarts the site Pod)"
  "MongoDB requires TLS (MONGO_TLS_MODE=requireTLS, restarts MongoDB)"
  "Wrap-up reminders"
)

usage() {
  cat <<'USAGE'
Usage: kubernetes/scripts/upgrade-mongo-tls.sh [--from-step N]

Staged rollout of TLS for chat-api <-> MongoDB. Each step asks first; answer
"n" to stop, then resume later with --from-step N.

  1. Preflight: config + secrets files, cluster reachable, pods running.
  2. mongo-tls.sh generate (skipped if a CA exists) + mongo-tls.sh apply.
  3. MONGO_TLS_MODE=preferTLS + deploy.sh: mongod serves TLS and plaintext.
  4. MONGO_TLS=true + deploy.sh: chat-api connects with TLS, verifying the
     server cert against the private CA.
  5. MONGO_TLS_MODE=requireTLS + deploy.sh: plaintext refused.
  6. Reminders (back up ca.key, cert expiry, rollback).

Rollback at any point: set MONGO_TLS=false and MONGO_TLS_MODE=preferTLS (or
disabled) in config.env and run deploy.sh.

Needs the chat-api release that understands MONGO_TLS (the encryption
release; see upgrade-encryption.sh).

Options:
  --from-step N   start at step N (step 1's read-only checks always run)
  -h, --help      this help
USAGE
}

FROM=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-step) FROM="${2:-}"; shift 2 ;;
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
  echo "Stopped before step $1. Resume with: kubernetes/scripts/upgrade-mongo-tls.sh --from-step $1"
  exit 1
}

pod_ready() {
  [[ "$(kubectl_cmd -n "$NAMESPACE" get "$1" -o jsonpath='{.status.readyReplicas}' 2>/dev/null)" == 1 ]]
}

manual_check() {
  echo "Manual check: log in at http://<onion>/admin/ in Tor Browser and open a conversation."
  confirm "Chat works?" || {
    echo "Roll back: MONGO_TLS=false / MONGO_TLS_MODE=preferTLS in config.env, then deploy.sh." >&2
    echo "chat-api logs: kubectl -n $NAMESPACE logs deployment/thecrypt -c chat-api --tail=50" >&2
    stop_at "$1"
  }
}

# ---------------------------------------------------------------- steps

step_1() {
  local ok=true
  [[ -f "$CONFIG_FILE" ]] || { echo "Missing $CONFIG_FILE" >&2; ok=false; }
  [[ -f "$SECRETS_FILE" ]] || { echo "Missing $SECRETS_FILE — run: kubernetes/scripts/secrets.sh pull" >&2; ok=false; }
  if ! kubectl_cmd -n "$NAMESPACE" get pods >/dev/null; then
    echo "Cannot reach the cluster / namespace ${NAMESPACE}." >&2
    ok=false
  else
    pod_ready statefulset/thecrypt-mongo || { echo "MongoDB (statefulset/thecrypt-mongo) is not ready." >&2; ok=false; }
    pod_ready deployment/thecrypt || { echo "The site Pod (deployment/thecrypt) is not ready." >&2; ok=false; }
  fi
  [[ "$ok" == true ]] || exit 1
  kubectl_cmd -n "$NAMESPACE" get pods
  echo ""
  echo "MONGO_TLS_MODE: ${MONGO_TLS_MODE}   MONGO_TLS: ${MONGO_TLS}"
  echo "chat-api image: ${REGISTRY}/thecrypt-chat-api:${CHAT_API_TAG} (must support MONGO_TLS)"
  echo "Preflight OK."
}

step_2() {
  if [[ -f "${TLS_DIR}/ca.key" ]]; then
    echo "CA already in ${TLS_DIR}/ (keeping it)."
  else
    "${SCRIPT_DIR}/mongo-tls.sh" generate
  fi
  "${SCRIPT_DIR}/mongo-tls.sh" apply
  "${SCRIPT_DIR}/mongo-tls.sh" status
  echo ""
  echo "Back up ${TLS_DIR}/ca.key with secrets.local.env (needed to renew the server cert)."
}

step_3() {
  load_config
  case "$MONGO_TLS_MODE" in
    preferTLS|requireTLS) echo "MONGO_TLS_MODE is already ${MONGO_TLS_MODE}." ;;
    *) config_set MONGO_TLS_MODE preferTLS ;;
  esac
  "${SCRIPT_DIR}/deploy.sh"
  # mongosh_pod connects with TLS now that mongo-tls is mounted in the pod.
  "${SCRIPT_DIR}/verify-mongo-app-user.sh"
  echo "MongoDB accepts TLS (verified: app user authenticated over TLS)."
}

step_4() {
  load_config
  [[ "$MONGO_TLS" == true ]] || config_set MONGO_TLS true
  "${SCRIPT_DIR}/deploy.sh"
  echo ""
  kubectl_cmd -n "$NAMESPACE" logs deployment/thecrypt -c chat-api --tail=15 || true
  echo ""
  manual_check 4
}

step_5() {
  load_config
  if [[ "$MONGO_TLS" != true ]]; then
    echo "MONGO_TLS is not true: requireTLS would cut chat-api off. Run step 4 first." >&2
    stop_at 4
  fi
  [[ "$MONGO_TLS_MODE" == requireTLS ]] || config_set MONGO_TLS_MODE requireTLS
  "${SCRIPT_DIR}/deploy.sh"
  "${SCRIPT_DIR}/verify-mongo-app-user.sh"
  if kubectl_cmd -n "$NAMESPACE" exec statefulset/thecrypt-mongo -c mongo -- \
       mongosh --quiet --norc --host 127.0.0.1 --eval "db.adminCommand('ping').ok" >/dev/null 2>&1; then
    echo "A plaintext connection still succeeded — requireTLS is not in effect." >&2
    exit 1
  fi
  echo "Plaintext connections are refused; TLS works."
  manual_check 5
}

step_6() {
  cat <<EOF
Mongo TLS is on (MONGO_TLS_MODE=requireTLS, MONGO_TLS=true).

 * Back up ${TLS_DIR}/ca.key (with secrets.local.env). Lose it and the next
   renewal means a new CA (mongo-tls.sh generate --force) — still fine, just
   both pods restart.
 * Server cert expiry: $(openssl x509 -in "${TLS_DIR}/server.crt" -noout -enddate 2>/dev/null || echo "see mongo-tls.sh status")
   Renew before then:  mongo-tls.sh renew && mongo-tls.sh apply && deploy.sh
 * Rollback: MONGO_TLS=false + MONGO_TLS_MODE=preferTLS in config.env, deploy.sh.
EOF
}

# ---------------------------------------------------------------- main

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
