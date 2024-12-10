FROM debian:bullseye-slim

# Install Tor and Nginx
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    tor nginx && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Create hidden service directory
RUN mkdir -p /var/lib/tor/hidden_service && chmod 700 /var/lib/tor/hidden_service

# Copy website files
COPY --from=bootstrapicons /root/icons/font /var/www/html/font
COPY --from=bootstrap-build /root/bootstrap/dist /var/www/html/dist
COPY --from=customcssjs /root/website/css /var/www/html/css
COPY --from=customcssjs /root/website/js /var/www/html/biopsy-1/js
COPY --from=customcssjs /root/website/js /var/www/html/biopsy-2/js
COPY --from=customcssjs /root/website/js /var/www/html/biopsy-3/js

COPY ./website /var/www/html
RUN rm /var/www/html/index.nginx-debian.html

# Copy custom torrc file
COPY tor/torrc /etc/tor/torrc
COPY tor/hidden_service /var/lib/tor/hidden_service

# Copy the startup script
COPY entry.sh /entry.sh
RUN chmod +x /entry.sh

# Expose necessary ports
EXPOSE 80 9050

# Start Tor and Nginx
CMD ["/entry.sh"]
