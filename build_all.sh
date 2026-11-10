#!/bin/bash
# Build the three deployable images. All Dockerfiles are self-contained
# (vendor assets pulled from pinned npm dist), so no separate build stages
# are needed.
#
#   REGISTRY=registry.example.com TAG=1.0.0 ./build_all.sh
#   PUSH=1 REGISTRY=registry.example.com ./build_all.sh   # build + push
#
# Building on x86 for a Raspberry Pi (arm64) cluster? Use buildx instead, e.g.
#   docker buildx build --platform linux/arm64 --push -t "$REGISTRY/thecrypt-website:$TAG" -f Dockerfile .
set -euo pipefail

REGISTRY="${REGISTRY:-registry.yourregistry.com}"
TAG="${TAG:-1.0.0}"

docker build -t "${REGISTRY}/thecrypt-website:${TAG}" -f Dockerfile .
docker build -t "${REGISTRY}/thecrypt-tor:${TAG}" -f container-images/tor-sidecar.dockerfile .
docker build -t "${REGISTRY}/thecrypt-chat-api:${TAG}" chat-api

if [ "${PUSH:-0}" = "1" ]; then
  for img in thecrypt-website thecrypt-tor thecrypt-chat-api; do
    docker push "${REGISTRY}/${img}:${TAG}"
  done
fi
