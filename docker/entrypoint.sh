#!/bin/sh
# BetterDesk — All-in-One Container Entrypoint
# Runs Go server + Node.js console via supervisord
set -e

echo "========================================"
echo "  BetterDesk All-in-One Container"
echo "  Version: 2.4.0"
echo "========================================"
echo ""
echo "Components:"
echo "  Go Server:    signal + relay + API (ports 21114-21119)"
echo "  Node.js Console: web panel (port ${PORT:-5000})"
echo "  Client API:   port ${API_PORT:-21121}"
echo ""
echo "Configuration:"
echo "  NODE_ENV:      ${NODE_ENV:-production}"
echo "  DB_TYPE:       ${DB_TYPE:-sqlite}"
echo "  ENCRYPTED_ONLY: ${ENCRYPTED_ONLY:-1}"
echo "  DATA_DIR:      ${DATA_DIR:-/app/data}"
echo ""

# Ensure data directories exist and have correct permissions
mkdir -p /opt/rustdesk /app/data /var/log/betterdesk 2>/dev/null || true
chown -R betterdesk:betterdesk /opt/rustdesk /app/data /var/log/betterdesk 2>/dev/null || true

# Wait for PostgreSQL if configured
if [ "${DB_TYPE}" = "postgres" ] || [ "${DB_TYPE}" = "postgresql" ]; then
    if [ -n "${DATABASE_URL}" ]; then
        echo "Waiting for PostgreSQL..."
        PG_HOST=$(echo "$DATABASE_URL" | sed -n 's|.*@\([^:/]*\).*|\1|p')
        PG_PORT=$(echo "$DATABASE_URL" | sed -n 's|.*:\([0-9]*\)/.*|\1|p')
        PG_PORT=${PG_PORT:-5432}
        RETRIES=0
        MAX_RETRIES=30
        while [ "$RETRIES" -lt "$MAX_RETRIES" ]; do
            if nc -z "$PG_HOST" "$PG_PORT" 2>/dev/null; then
                echo "  PostgreSQL is ready ($PG_HOST:$PG_PORT)"
                break
            fi
            RETRIES=$((RETRIES + 1))
            echo "  Waiting... ($RETRIES/$MAX_RETRIES)"
            sleep 2
        done
        if [ "$RETRIES" -ge "$MAX_RETRIES" ]; then
            echo "  WARNING: PostgreSQL not reachable — starting anyway"
        fi
    fi
fi

echo ""
echo "Starting services via supervisord..."
echo "  Web Console:  http://localhost:${PORT:-5000}"
echo "  Go API:       http://localhost:21114/api"
echo "========================================"
echo ""

# Start supervisord (manages both processes)
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/betterdesk.conf
