#!/usr/bin/env bash
# Build and push the three images for the cluster's platform (buildx), using
# REGISTRY / *_TAG / PLATFORM from kubernetes/config.env.
#
#   kubernetes/scripts/build-push.sh            # all three
#   kubernetes/scripts/build-push.sh website chat-api
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"
load_config

targets=("$@")
[[ ${#targets[@]} -eq 0 ]] && targets=(website chat-api tor)

builder_args=()
[[ -n "$BUILDX_BUILDER" ]] && builder_args=(--builder "$BUILDX_BUILDER")

cd "$REPO_ROOT"
for t in "${targets[@]}"; do
  case "$t" in
    website)  ref="${REGISTRY}/thecrypt-website:${WEBSITE_TAG}";   args=(-f Dockerfile .) ;;
    chat-api) ref="${REGISTRY}/thecrypt-chat-api:${CHAT_API_TAG}"; args=(chat-api) ;;
    tor)      ref="${REGISTRY}/thecrypt-tor:${TOR_TAG}";           args=(-f container-images/tor-sidecar.dockerfile .) ;;
    *) echo "Unknown image: $t (website | chat-api | tor)" >&2; exit 1 ;;
  esac
  echo "== $ref ($PLATFORM)"
  docker buildx build "${builder_args[@]}" --platform "$PLATFORM" --push -t "$ref" "${args[@]}"
done
