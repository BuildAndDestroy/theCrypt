#!/bin/bash

# Start Nginx in the background
/usr/sbin/nginx -g "daemon off;" &

# Start Tor in the foreground
tor -f /etc/tor/torrc
