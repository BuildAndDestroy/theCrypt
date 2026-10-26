# Production website image: nginx only, self-contained (no external build
# stages, no registry round-trips). Tor runs as a separate sidecar container
# (see kubernetes/deployment-sidecar.yaml) and reaches this nginx over the
# Pod loopback. Vendor assets come from pinned npm dist; custom CSS/JS are
# minified at build time.

# ---- Stage 1: build/minify assets ----
FROM node:22-slim AS assets

WORKDIR /build
RUN npm install --no-save \
    bootstrap@5.3.3 \
    bootstrap-icons@1.11.3 \
    clean-css-cli@5.6.3 \
    terser@5.31.6

COPY website/css/custom-styles.css ./custom-styles.css
COPY website/js/countdown.js ./countdown.js
RUN npx cleancss -o custom-styles.min.css custom-styles.css && \
    npx terser countdown.js -o countdown.min.js --compress --mangle

# ---- Stage 2: nginx ----
FROM debian:bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends nginx && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Vendor assets.
COPY --from=assets /build/node_modules/bootstrap/dist /var/www/html/dist
COPY --from=assets /build/node_modules/bootstrap-icons/font /var/www/html/font

# Hand-authored site, then the minified custom assets on top.
COPY website/ /var/www/html/
COPY --from=assets /build/custom-styles.min.css /var/www/html/css/custom-styles.min.css
COPY --from=assets /build/countdown.min.js /var/www/html/biopsy-1/js/countdown.min.js
COPY --from=assets /build/countdown.min.js /var/www/html/biopsy-2/js/countdown.min.js
COPY --from=assets /build/countdown.min.js /var/www/html/biopsy-3/js/countdown.min.js
RUN rm -f /var/www/html/index.nginx-debian.html

# Hardened nginx config (anti-leak headers, loopback-only). Replace the
# default Debian site so our server block is the only one on port 80.
COPY nginx-hardening.conf /etc/nginx/snippets/crypt-hardening.conf
COPY nginx-prod.conf /etc/nginx/conf.d/default.conf
RUN rm -f /etc/nginx/sites-enabled/default

# Loopback only; the Tor sidecar connects over 127.0.0.1.
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
