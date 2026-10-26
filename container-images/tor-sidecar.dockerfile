# Tor sidecar for The Crypt hidden service.
# Ships NO keys and NO torrc — both are supplied at runtime (torrc from a
# ConfigMap, the onion key from a Secret). Nothing identifying is baked into
# the image or committed to git.
FROM debian:bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends tor && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Run as a dedicated non-root user. UID 1000 matches the chown performed by
# the Kubernetes initContainer that stages the onion key into the emptyDir.
# Tor needs no root here: SocksPort is disabled and it binds no low ports.
RUN useradd --system --uid 1000 --shell /usr/sbin/nologin tor-hs && \
    mkdir -p /var/lib/tor/hidden_service && \
    chown -R 1000:1000 /var/lib/tor && \
    chmod 700 /var/lib/tor/hidden_service

USER 1000

# HiddenServiceDir is populated at runtime (initContainer) into an emptyDir.
EXPOSE 9050

# Liveness: Tor writes the onion hostname once the service is published.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD test -f /var/lib/tor/hidden_service/hostname || exit 1

CMD ["tor", "-f", "/etc/tor/torrc"]
