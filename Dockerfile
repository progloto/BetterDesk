# BetterDesk — Single Container Image
# =====================================
# Combines Go server (signal + relay + API) and Node.js web console
# into a single container using supervisord as process manager.
#
# Build:  docker build -t betterdesk:local .
# Run:    docker compose up -d
#
# Ports:
#   21114 - HTTP API (Go server)
#   21115 - NAT type test
#   21116 - Signal TCP/UDP
#   21117 - Relay TCP
#   21118 - WebSocket Signal
#   21119 - WebSocket Relay
#   5000  - Web Console (Node.js)
#   21121 - RustDesk Client API (Node.js, WAN-facing)

# ============= Stage 1: Build Go server =============
FROM golang:1.25-alpine AS go-builder

RUN apk add --no-cache git gcc musl-dev sqlite-dev

WORKDIR /src
COPY betterdesk-server/go.mod betterdesk-server/go.sum ./
RUN go mod download

COPY betterdesk-server/ .
RUN CGO_ENABLED=1 GOOS=linux go build \
    -ldflags="-s -w -extldflags '-static'" \
    -tags "sqlite_omit_load_extension netgo osusergo" \
    -o /betterdesk-server .

# ============= Stage 2: Build Node.js console =============
FROM node:20-alpine AS node-builder

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3, bcrypt)
RUN apk add --no-cache python3 make g++ sqlite-dev

COPY web-nodejs/package.json web-nodejs/package-lock.json* ./
RUN npm install --production --ignore-scripts && \
    npm rebuild bcrypt better-sqlite3

# ============= Stage 3: Production runtime =============
# Note: supervisord requires root to manage child processes with user= directive.
# Both betterdesk-server and betterdesk-console run as non-root 'betterdesk' user
# via supervisord configuration (user=betterdesk).
FROM node:20-alpine

LABEL maintainer="UNITRONIX"
LABEL description="BetterDesk — All-in-One (Go Server + Node.js Console)"
LABEL version="2.4.0"

# Install runtime packages
RUN apk add --no-cache \
    ca-certificates \
    curl \
    sqlite \
    tini \
    supervisor \
    && mkdir -p /var/log/supervisor

# Create betterdesk user and directories
RUN addgroup -S betterdesk && \
    adduser -S -G betterdesk betterdesk && \
    mkdir -p /opt/rustdesk /app/data /var/log/betterdesk && \
    chown -R betterdesk:betterdesk /opt/rustdesk /app/data /var/log/betterdesk

# ---- Go server binary ----
COPY --from=go-builder /betterdesk-server /usr/local/bin/betterdesk-server
RUN chmod +x /usr/local/bin/betterdesk-server

# ---- Node.js console ----
WORKDIR /app
COPY --from=node-builder /app/node_modules ./node_modules
COPY web-nodejs/ .

# ---- Supervisord config ----
COPY docker/supervisord.conf /etc/supervisor/conf.d/betterdesk.conf

# ---- Entrypoint ----
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Environment variables (defaults)
ENV NODE_ENV=production
ENV PORT=5000
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data
ENV RUSTDESK_PATH=/opt/rustdesk
ENV DB_PATH=/opt/rustdesk/db_v2.sqlite3
ENV PUB_KEY_PATH=/opt/rustdesk/id_ed25519.pub
ENV API_KEY_PATH=/opt/rustdesk/.api_key
ENV SERVER_BACKEND=betterdesk
ENV HBBS_API_URL=http://127.0.0.1:21114/api
ENV BETTERDESK_API_URL=http://127.0.0.1:21114/api
ENV DOCKER=true
ENV ENCRYPTED_ONLY=1

# Expose all ports
EXPOSE 5000 21114 21115 21116/tcp 21116/udp 21117 21118 21119 21121

# Health check: both Go server API and Node.js console must be healthy
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -sf http://localhost:21114/api/health && curl -sf http://localhost:5000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/entrypoint.sh"]
