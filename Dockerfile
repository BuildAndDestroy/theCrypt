FROM debian:bullseye-slim

# Website image: nginx only. Tor runs as a separate sidecar container
# (see kubernetes/deployment-sidecar.yaml), which reaches this nginx over
# the Pod's loopback and publishes the hidden service.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    nginx && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Copy website files (vendor assets + minified custom css/js from the
# build_all.sh stages, then the hand-authored site on top).
COPY --from=bootstrapicons /root/icons/font /var/www/html/font
COPY --from=bootstrap-build /root/bootstrap/dist /var/www/html/dist
COPY --from=customcssjs /root/website/css /var/www/html/css
COPY --from=customcssjs /root/website/js /var/www/html/biopsy-1/js
COPY --from=customcssjs /root/website/js /var/www/html/biopsy-2/js
COPY --from=customcssjs /root/website/js /var/www/html/biopsy-3/js

COPY ./website /var/www/html
RUN rm /var/www/html/index.nginx-debian.html

# Hardened nginx config (anti-leak headers, loopback-only). Replace the
# default Debian site so our server block is the only one on port 80.
COPY nginx-hardening.conf /etc/nginx/snippets/crypt-hardening.conf
COPY nginx-prod.conf /etc/nginx/conf.d/default.conf
RUN rm -f /etc/nginx/sites-enabled/default

# Loopback only; the Tor sidecar connects over 127.0.0.1.
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
