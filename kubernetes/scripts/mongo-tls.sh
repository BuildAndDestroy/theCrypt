#!/usr/bin/env bash
# TLS material for MongoDB: a private CA and a server certificate, kept in
# kubernetes/mongo-tls/ (gitignored; keys mode 600), and the mongo-tls Secret.
#
#   mongo-tls.sh generate [--force]   new CA + server cert (--force: replace the CA)
#   mongo-tls.sh renew                new server cert from the existing CA
#   mongo-tls.sh apply                create/update the mongo-tls Secret
#   mongo-tls.sh status               show the local certs and the Secret
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"
load_config

CA_DAYS=3650       # 10 years
SERVER_DAYS=825    # ~27 months; renew before it ends (status shows the date)

usage() {
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
  cat <<USAGE

Files in ${TLS_DIR}/:
  ca.key       CA private key (EC P-256). Only used to sign server certs; it
               never goes into the cluster. Back it up with secrets.local.env.
  ca.crt       CA certificate      -> Secret mongo-tls ca.crt (mongod + chat-api)
  server.key   server private key
  server.crt   server certificate, SAN: thecrypt-mongo.${NAMESPACE}.svc.cluster.local,
               thecrypt-mongo.${NAMESPACE}.svc, thecrypt-mongo, localhost, 127.0.0.1
  server.pem   server.crt + server.key -> Secret mongo-tls server.pem (mongod only)

The Secret is used when MONGO_TLS_MODE (mongod) is not "disabled" and/or
MONGO_TLS=true (chat-api) in config.env. deploy.sh restarts the pods when the
Secret changes. Staged rollout on a running site: upgrade-mongo-tls.sh
USAGE
}

server_cn() { echo "thecrypt-mongo.${NAMESPACE}.svc.cluster.local"; }

# Sign a fresh server key/cert with the CA in TLS_DIR.
issue_server_cert() {
  local work ext
  TLS_TMP="$(mktemp -d)"
  trap 'rm -rf "${TLS_TMP:-}"' EXIT
  work="$TLS_TMP"
  ext="${work}/server.ext"
  cat > "$ext" <<EXT
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid, issuer
subjectAltName = DNS:$(server_cn), DNS:thecrypt-mongo.${NAMESPACE}.svc, DNS:thecrypt-mongo, DNS:localhost, IP:127.0.0.1
EXT
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "${TLS_DIR}/server.key" 2>/dev/null
  chmod 600 "${TLS_DIR}/server.key"
  openssl req -new -key "${TLS_DIR}/server.key" -subj "/CN=$(server_cn)" -out "${work}/server.csr"
  openssl x509 -req -in "${work}/server.csr" -CA "${TLS_DIR}/ca.crt" -CAkey "${TLS_DIR}/ca.key" \
    -set_serial "0x$(openssl rand -hex 16)" -days "$SERVER_DAYS" -sha256 \
    -extfile "$ext" -out "${TLS_DIR}/server.crt" 2>/dev/null
  cat "${TLS_DIR}/server.crt" "${TLS_DIR}/server.key" > "${TLS_DIR}/server.pem"
  chmod 600 "${TLS_DIR}/server.pem"
  chmod 644 "${TLS_DIR}/server.crt"
  openssl verify -CAfile "${TLS_DIR}/ca.crt" "${TLS_DIR}/server.crt" >/dev/null
  echo "Server cert: $(openssl x509 -in "${TLS_DIR}/server.crt" -noout -enddate)"
}

cmd_generate() {
  local force=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --force) force=true; shift ;;
      *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
  done
  if [[ -f "${TLS_DIR}/ca.key" && "$force" != true ]]; then
    echo "${TLS_DIR}/ca.key already exists. 'renew' issues a new server cert from it;" >&2
    echo "'generate --force' replaces the CA (mongod and chat-api must both restart)." >&2
    exit 1
  fi
  umask 077
  mkdir -p "$TLS_DIR"
  chmod 700 "$TLS_DIR"
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "${TLS_DIR}/ca.key" 2>/dev/null
  chmod 600 "${TLS_DIR}/ca.key"
  openssl req -x509 -new -key "${TLS_DIR}/ca.key" -sha256 -days "$CA_DAYS" \
    -subj "/CN=thecrypt-mongo-ca" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -out "${TLS_DIR}/ca.crt"
  chmod 644 "${TLS_DIR}/ca.crt"
  echo "CA:          $(openssl x509 -in "${TLS_DIR}/ca.crt" -noout -enddate)"
  issue_server_cert
  echo "Wrote ${TLS_DIR}/ (keys mode 600). Back up ca.key. Next: mongo-tls.sh apply"
}

cmd_renew() {
  [[ -f "${TLS_DIR}/ca.key" && -f "${TLS_DIR}/ca.crt" ]] || {
    echo "No CA in ${TLS_DIR}/ — run: mongo-tls.sh generate" >&2; exit 1; }
  umask 077
  issue_server_cert
  echo "Next: mongo-tls.sh apply && deploy.sh (restarts mongod with the new cert)"
}

cmd_apply() {
  local f
  for f in ca.crt server.pem; do
    [[ -f "${TLS_DIR}/${f}" ]] || { echo "Missing ${TLS_DIR}/${f} — run: mongo-tls.sh generate" >&2; exit 1; }
  done
  openssl verify -CAfile "${TLS_DIR}/ca.crt" "${TLS_DIR}/server.crt" >/dev/null
  kubectl_cmd get namespace "$NAMESPACE" >/dev/null 2>&1 || kubectl_cmd create namespace "$NAMESPACE"
  kubectl_cmd -n "$NAMESPACE" create secret generic mongo-tls \
    --from-file=ca.crt="${TLS_DIR}/ca.crt" --from-file=server.pem="${TLS_DIR}/server.pem" \
    --dry-run=client -o yaml | apply_stdin
  [[ "$(secret_value mongo-tls ca.crt)" == "$(cat "${TLS_DIR}/ca.crt")" ]] || {
    echo "ERROR: mongo-tls ca.crt did not apply" >&2; exit 1; }
  echo "Run deploy.sh to restart the pods that use it."
}

cmd_status() {
  if [[ -f "${TLS_DIR}/server.crt" ]]; then
    openssl x509 -in "${TLS_DIR}/ca.crt" -noout -subject -enddate | sed 's/^/CA      /'
    openssl x509 -in "${TLS_DIR}/server.crt" -noout -subject -enddate -ext subjectAltName | sed 's/^/server  /'
    if openssl x509 -in "${TLS_DIR}/server.crt" -noout -checkend $((30 * 86400)) >/dev/null; then
      echo "server cert valid for 30+ days"
    else
      echo "WARNING: server cert expires within 30 days — mongo-tls.sh renew" >&2
    fi
  else
    echo "No local certs in ${TLS_DIR}/"
  fi
  if secret_exists mongo-tls; then
    if [[ -f "${TLS_DIR}/server.pem" && "$(secret_value mongo-tls server.pem)" == "$(cat "${TLS_DIR}/server.pem")" ]]; then
      echo "Secret mongo-tls: present, matches local files"
    else
      echo "Secret mongo-tls: present, DIFFERS from local files (mongo-tls.sh apply)"
    fi
  else
    echo "Secret mongo-tls: absent"
  fi
  echo "config.env: MONGO_TLS_MODE=${MONGO_TLS_MODE} MONGO_TLS=${MONGO_TLS}"
}

case "${1:-}" in
  generate) shift; cmd_generate "$@" ;;
  renew) cmd_renew ;;
  apply) cmd_apply ;;
  status) cmd_status ;;
  -h|--help|"") usage ;;
  *) echo "Unknown command: $1" >&2; usage; exit 1 ;;
esac
