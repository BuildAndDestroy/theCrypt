#!/usr/bin/env bash
# Manage the deploy secrets file (kubernetes/secrets.local.env, gitignored,
# mode 600) and the Kubernetes Secrets built from it.
#
#   secrets.sh generate     new random credentials (new install)
#   secrets.sh pull         write the file from the Secrets already in the cluster
#   secrets.sh apply        create/update mongo-auth + chat-admin from the file
#   secrets.sh show-admin   print the operator login (+ authenticator QR code)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"
load_config

usage() {
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'USAGE'

Options:
  --force            generate: overwrite an existing secrets file
  --admin-email X    generate: operator login email (default operator@example.invalid)

The secrets file holds:
  MONGO_ROOT_USERNAME / MONGO_ROOT_PASSWORD   mongo-auth root_*  (init + probes)
  MONGO_APP_USERNAME  / MONGO_APP_PASSWORD    mongo-auth app_*   (used by chat-api)
  ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_TOTP_SECRET   chat-admin

MongoDB reads mongo-auth ONCE, on an empty data directory. After that,
changing root_* does nothing; changing app_* is fixed up by deploy.sh
(re-runs the init script as root). Keep this file backed up.
USAGE
}

write_secrets_file() {
  umask 077
  {
    echo "# The Crypt deploy secrets — NEVER commit. Generated $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    local k
    for k in MONGO_ROOT_USERNAME MONGO_ROOT_PASSWORD MONGO_APP_USERNAME MONGO_APP_PASSWORD \
             ADMIN_EMAIL ADMIN_PASSWORD ADMIN_TOTP_SECRET; do
      printf '%s=%q\n' "$k" "${!k}"
    done
  } > "$SECRETS_FILE"
  chmod 600 "$SECRETS_FILE"
  echo "Wrote $SECRETS_FILE (mode 600). Back it up somewhere safe."
}

cmd_generate() {
  local force=false email="operator@example.invalid"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --force) force=true; shift ;;
      --admin-email) email="$2"; shift 2 ;;
      *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
  done
  if [[ -f "$SECRETS_FILE" && "$force" != true ]]; then
    echo "$SECRETS_FILE already exists (use --force to overwrite)." >&2
    exit 1
  fi
  if secret_exists mongo-auth; then
    echo "Warning: mongo-auth already exists in the cluster. New Mongo passwords will" >&2
    echo "NOT match an initialised database. You probably want: secrets.sh pull" >&2
    confirm "Generate anyway?" || exit 1
  fi
  MONGO_ROOT_USERNAME=crypt-root
  MONGO_ROOT_PASSWORD="$(openssl rand -hex 24)"
  MONGO_APP_USERNAME=crypt-app
  MONGO_APP_PASSWORD="$(openssl rand -hex 24)"
  ADMIN_EMAIL="$email"
  ADMIN_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=')"
  ADMIN_TOTP_SECRET="$(head -c 20 /dev/urandom | base32 | tr -d '=\n')"
  write_secrets_file
}

cmd_pull() {
  if [[ -f "$SECRETS_FILE" ]]; then
    confirm "$SECRETS_FILE exists. Overwrite with the cluster's values?" || exit 1
  fi
  MONGO_ROOT_USERNAME="$(secret_value mongo-auth root_username)"
  MONGO_ROOT_PASSWORD="$(secret_value mongo-auth root_password)"
  MONGO_APP_USERNAME="$(secret_value mongo-auth app_username)"
  MONGO_APP_PASSWORD="$(secret_value mongo-auth app_password)"
  ADMIN_EMAIL="$(secret_value chat-admin email)"
  ADMIN_PASSWORD="$(secret_value chat-admin password)"
  ADMIN_TOTP_SECRET="$(secret_value chat-admin totp_secret 2>/dev/null || true)"
  write_secrets_file
}

cmd_apply() {
  load_secrets
  if (( ${#ADMIN_PASSWORD} < 16 )); then
    echo "ADMIN_PASSWORD must be at least 16 characters." >&2
    exit 1
  fi
  kubectl_cmd get namespace "$NAMESPACE" >/dev/null 2>&1 || kubectl_cmd create namespace "$NAMESPACE"

  if secret_exists mongo-auth && [[ "$(secret_value mongo-auth root_password)" != "$MONGO_ROOT_PASSWORD" ]]; then
    echo "Note: root_password differs from the cluster. An initialised MongoDB keeps" >&2
    echo "its original root password; only a fresh (empty) volume will use the new one." >&2
  fi

  # Values are written to a private temp dir (mode 700, removed on exit) and
  # read with --from-file, so they never appear in argv / `ps`.
  umask 077
  SECRETS_TMP="$(mktemp -d)"
  chmod 700 "$SECRETS_TMP"
  trap 'rm -rf "${SECRETS_TMP:-}"' EXIT
  local tmp="$SECRETS_TMP"
  put() { printf %s "$2" > "${tmp}/$1"; }

  put root_username "$MONGO_ROOT_USERNAME"
  put root_password "$MONGO_ROOT_PASSWORD"
  put app_username "$MONGO_APP_USERNAME"
  put app_password "$MONGO_APP_PASSWORD"
  kubectl_cmd -n "$NAMESPACE" create secret generic mongo-auth \
    --from-file="${tmp}/root_username" --from-file="${tmp}/root_password" \
    --from-file="${tmp}/app_username" --from-file="${tmp}/app_password" \
    --dry-run=client -o yaml | apply_stdin

  put email "$ADMIN_EMAIL"
  put password "$ADMIN_PASSWORD"
  local admin_files=(--from-file="${tmp}/email" --from-file="${tmp}/password")
  if [[ -n "${ADMIN_TOTP_SECRET:-}" ]]; then
    put totp_secret "$ADMIN_TOTP_SECRET"
    admin_files+=(--from-file="${tmp}/totp_secret")
  fi
  kubectl_cmd -n "$NAMESPACE" create secret generic chat-admin "${admin_files[@]}" \
    --dry-run=client -o yaml | apply_stdin

  # Every value must have landed non-empty (guards against a silent blank).
  local k
  for k in mongo-auth:root_password mongo-auth:app_password chat-admin:password; do
    [[ -n "$(secret_value "${k%%:*}" "${k#*:}")" ]] || { echo "ERROR: ${k} is empty in the cluster" >&2; exit 1; }
  done
  if [[ -n "${ADMIN_TOTP_SECRET:-}" && "$(secret_value chat-admin totp_secret)" != "$ADMIN_TOTP_SECRET" ]]; then
    echo "ERROR: chat-admin totp_secret did not apply" >&2; exit 1
  fi
}

cmd_show_admin() {
  local email pw totp
  email="$(secret_value chat-admin email)"
  pw="$(secret_value chat-admin password)"
  totp="$(secret_value chat-admin totp_secret 2>/dev/null || true)"
  echo "Email:     $email"
  echo "Password:  $pw"
  if [[ -n "$totp" ]]; then
    echo "TOTP key:  $totp   (time-based, 6 digits, 30 s)"
    if command -v qrencode >/dev/null 2>&1; then
      qrencode -t ansiutf8 "otpauth://totp/TheCrypt:operator?issuer=TheCrypt&secret=${totp}"
    else
      echo "(install qrencode to show it as a QR code)"
    fi
  else
    echo "TOTP:      not enabled"
  fi
}

case "${1:-}" in
  generate) shift; cmd_generate "$@" ;;
  pull) cmd_pull ;;
  apply) cmd_apply ;;
  show-admin) cmd_show_admin ;;
  -h|--help|"") usage ;;
  *) echo "Unknown command: $1" >&2; usage; exit 1 ;;
esac
