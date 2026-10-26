# Production website image: unprivileged nginx, self-contained (no external
# build stages). Runs as non-root (uid 101) and listens on 8080. Tor runs as
# a separate sidecar (see kubernetes/deployment-sidecar.yaml) and reaches
# this nginx over the Pod loopback. Vendor assets come from pinned npm dist;
# custom CSS/JS are minified at build time.

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

# ---- Stage 2: unprivileged nginx ----
FROM nginxinc/nginx-unprivileged:1.27-alpine

# COPY needs write access to the (root-owned) web root.
USER root

# Vendor assets.
COPY --from=assets /build/node_modules/bootstrap/dist /usr/share/nginx/html/dist
COPY --from=assets /build/node_modules/bootstrap-icons/font /usr/share/nginx/html/font

# Hand-authored site, then the minified custom assets on top.
COPY website/ /usr/share/nginx/html/
COPY --from=assets /build/custom-styles.min.css /usr/share/nginx/html/css/custom-styles.min.css
COPY --from=assets /build/countdown.min.js /usr/share/nginx/html/biopsy-1/js/countdown.min.js
COPY --from=assets /build/countdown.min.js /usr/share/nginx/html/biopsy-2/js/countdown.min.js
COPY --from=assets /build/countdown.min.js /usr/share/nginx/html/biopsy-3/js/countdown.min.js

# Hardened nginx config (anti-leak headers, loopback-only).
COPY nginx-hardening.conf /etc/nginx/snippets/crypt-hardening.conf
COPY nginx-prod.conf /etc/nginx/conf.d/default.conf

# Back to the image's non-root user.
USER 101

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/ >/dev/null 2>&1 || exit 1

EXPOSE 8080
