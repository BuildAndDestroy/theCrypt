#!/bin/bash
# Build the two deployable images. Both Dockerfiles are self-contained
# (vendor assets pulled from pinned npm dist), so no separate build stages
# are needed. Update the tags to match your registry before pushing.
set -euo pipefail

docker build -t registry.yourregistry.com/thecrypt-website -f Dockerfile .
docker build -t registry.yourregistry.com/thecrypt-tor -f container-images/tor-sidecar.dockerfile .
