FROM debian:latest
# Install Tor and necessary tools
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    tor && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Create directories for Tor
RUN mkdir -p /var/lib/tor/hidden_service && \
    chmod 700 /var/lib/tor/hidden_service

# Set the Tor configuration directory
#VOLUME ["/var/lib/tor/hidden_service"]
COPY tor/hidden_service /var/lib/tor/hidden_service

# Copy custom torrc file
COPY tor/torrc /etc/tor/torrc

# Expose necessary ports
# SOCKS Proxy Port
EXPOSE 9050
# Hidden service port (HTTP in this case)
EXPOSE 80

# Start Tor
CMD ["tor", "-f", "/etc/tor/torrc"]

