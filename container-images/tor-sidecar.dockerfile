# Tor sidecar for The Crypt hidden service.
# Ships NO keys and NO torrc — both are supplied at runtime (torrc from a
# ConfigMap, the onion key from a Secret). Nothing identifying is baked into
# the image or committed to git.
FROM debian:bullseye-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends tor && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# HiddenServiceDir is populated at runtime (initContainer) into an emptyDir.
EXPOSE 9050

CMD ["tor", "-f", "/etc/tor/torrc"]
