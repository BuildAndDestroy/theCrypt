# The Crypt — operator chat API.
# Pure-JS dependencies only (no native modules; Argon2id comes from Node 24's
# built-in crypto), so it cross-builds cleanly for the Pi cluster
# (linux/arm64). Runs as non-root with a read-only root FS.

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Same UID as the other containers in the Pod.
USER 10001

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

EXPOSE 3000
CMD ["node", "src/index.js"]
