#!/bin/bash
# BetterDesk Pro Features Diagnostic Script
# Run on the production SSH server to diagnose why sysinfo is not being received
# Usage: bash diagnose_pro_features.sh

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║      BetterDesk Pro Features Diagnostic Script v1.0          ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Configuration - adjust paths if needed
BETTERDESK_DIR="${BETTERDESK_DIR:-/opt/rustdesk}"
AUTH_DB="${AUTH_DB:-$BETTERDESK_DIR/auth.db}"
DATA_DB="${DATA_DB:-$BETTERDESK_DIR/data/auth.db}"
NODE_DIR="${NODE_DIR:-$BETTERDESK_DIR}"

# Try to find auth.db
find_auth_db() {
    if [ -f "$AUTH_DB" ]; then
        echo "$AUTH_DB"
    elif [ -f "$DATA_DB" ]; then
        echo "$DATA_DB"
    elif [ -f "/opt/rustdesk/web-nodejs/data/auth.db" ]; then
        echo "/opt/rustdesk/web-nodejs/data/auth.db"
    elif [ -f "./data/auth.db" ]; then
        echo "./data/auth.db"
    else
        # Search for it
        find /opt -name "auth.db" 2>/dev/null | head -1
    fi
}

DB_PATH=$(find_auth_db)

echo -e "${YELLOW}═══ Test 1: Locate auth.db ═══${NC}"
if [ -z "$DB_PATH" ] || [ ! -f "$DB_PATH" ]; then
    echo -e "${RED}✗ auth.db not found!${NC}"
    echo "  Searched: $AUTH_DB, $DATA_DB, /opt/rustdesk/web-nodejs/data/auth.db"
    echo "  Please set AUTH_DB environment variable and re-run"
    exit 1
else
    echo -e "${GREEN}✓ Found: $DB_PATH${NC}"
    ls -la "$DB_PATH"
fi
echo ""

echo -e "${YELLOW}═══ Test 2: Check Pro Tables ═══${NC}"
PRO_TABLES=("peer_sysinfo" "peer_metrics" "audit_connections" "audit_files" "audit_alarms" "device_groups" "strategies")
MISSING_TABLES=0

for table in "${PRO_TABLES[@]}"; do
    EXISTS=$(sqlite3 "$DB_PATH" "SELECT name FROM sqlite_master WHERE type='table' AND name='$table';" 2>/dev/null || echo "")
    if [ -z "$EXISTS" ]; then
        echo -e "${RED}✗ Missing table: $table${NC}"
        MISSING_TABLES=$((MISSING_TABLES + 1))
    else
        echo -e "${GREEN}✓ Table exists: $table${NC}"
    fi
done

if [ $MISSING_TABLES -gt 0 ]; then
    echo -e "${RED}"
    echo "══════════════════════════════════════════════════════════════"
    echo "  PROBLEM: $MISSING_TABLES Pro tables are missing!"
    echo "  SOLUTION: Restart the web-nodejs server to create tables"
    echo "    sudo systemctl restart betterdesk-console"
    echo "══════════════════════════════════════════════════════════════"
    echo -e "${NC}"
fi
echo ""

echo -e "${YELLOW}═══ Test 3: Check peer_sysinfo Contents ═══${NC}"
if sqlite3 "$DB_PATH" "SELECT 1 FROM sqlite_master WHERE type='table' AND name='peer_sysinfo';" 2>/dev/null | grep -q 1; then
    COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM peer_sysinfo;" 2>/dev/null || echo "0")
    echo "  Entries in peer_sysinfo: $COUNT"
    if [ "$COUNT" = "0" ]; then
        echo -e "${YELLOW}  ⚠ No sysinfo data received yet${NC}"
    else
        echo -e "${GREEN}  ✓ Sysinfo data exists${NC}"
        echo "  Recent entries:"
        sqlite3 -header -column "$DB_PATH" "SELECT peer_id, hostname, cpu_name, memory_gb, updated_at FROM peer_sysinfo ORDER BY updated_at DESC LIMIT 5;" 2>/dev/null || true
    fi
else
    echo -e "${RED}  ✗ Table peer_sysinfo does not exist${NC}"
fi
echo ""

echo -e "${YELLOW}═══ Test 4: Check Node.js Server Status ═══${NC}"
if systemctl is-active --quiet betterdesk-console 2>/dev/null; then
    echo -e "${GREEN}✓ betterdesk-console service is running${NC}"
elif systemctl is-active --quiet rustdesk-console 2>/dev/null; then
    echo -e "${GREEN}✓ rustdesk-console service is running${NC}"
else
    # Check if node is running
    if pgrep -f "node.*server.js" > /dev/null; then
        echo -e "${GREEN}✓ Node.js server is running (manual start)${NC}"
    else
        echo -e "${RED}✗ No Node.js server found running${NC}"
        echo "  Try: sudo systemctl start betterdesk-console"
    fi
fi
echo ""

echo -e "${YELLOW}═══ Test 5: Check API Port (21121) ═══${NC}"
if ss -tlnp 2>/dev/null | grep -q ":21121"; then
    echo -e "${GREEN}✓ Port 21121 is listening${NC}"
    ss -tlnp | grep ":21121"
elif netstat -tlnp 2>/dev/null | grep -q ":21121"; then
    echo -e "${GREEN}✓ Port 21121 is listening${NC}"
    netstat -tlnp | grep ":21121"
else
    echo -e "${RED}✗ Port 21121 is NOT listening${NC}"
    echo "  The RustDesk Client API is not running!"
    echo "  Check API_PORT in .env or config"
fi
echo ""

echo -e "${YELLOW}═══ Test 6: Test API Endpoint Locally ═══${NC}"
echo "  Testing POST /api/sysinfo..."
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST http://localhost:21121/api/sysinfo \
  -H "Content-Type: application/json" \
  -d '{"id":"diagnostic-test","hostname":"DiagnosticPC","cpu":"Test CPU","memory":16}' 2>/dev/null || echo "FAILED")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✓ API responded with 200 OK${NC}"
    echo "  Response: $BODY"
    
    # Check if it was stored
    sleep 1
    STORED=$(sqlite3 "$DB_PATH" "SELECT peer_id FROM peer_sysinfo WHERE peer_id='diagnostic-test';" 2>/dev/null || echo "")
    if [ -n "$STORED" ]; then
        echo -e "${GREEN}✓ Test entry was stored in database${NC}"
        # Cleanup test entry
        sqlite3 "$DB_PATH" "DELETE FROM peer_sysinfo WHERE peer_id='diagnostic-test';" 2>/dev/null || true
    else
        echo -e "${YELLOW}⚠ Test entry was NOT stored (device may not exist in peers table)${NC}"
    fi
else
    echo -e "${RED}✗ API request failed (HTTP $HTTP_CODE)${NC}"
    echo "  Response: $BODY"
fi
echo ""

echo -e "${YELLOW}═══ Test 7: Check Firewall ═══${NC}"
if command -v ufw &> /dev/null; then
    UFW_STATUS=$(sudo ufw status 2>/dev/null | grep "21121" || echo "")
    if [ -n "$UFW_STATUS" ]; then
        echo -e "${GREEN}✓ UFW rule for 21121 exists${NC}"
        echo "  $UFW_STATUS"
    else
        UFW_ACTIVE=$(sudo ufw status 2>/dev/null | head -1 || echo "")
        if echo "$UFW_ACTIVE" | grep -q "active"; then
            echo -e "${YELLOW}⚠ UFW is active but no rule for port 21121${NC}"
            echo "  Add rule: sudo ufw allow 21121/tcp"
        else
            echo -e "${GREEN}✓ UFW is not active${NC}"
        fi
    fi
elif command -v firewall-cmd &> /dev/null; then
    FIREWALLD_STATUS=$(sudo firewall-cmd --list-ports 2>/dev/null | grep "21121" || echo "")
    if [ -n "$FIREWALLD_STATUS" ]; then
        echo -e "${GREEN}✓ Firewalld rule for 21121 exists${NC}"
    else
        echo -e "${YELLOW}⚠ Firewalld: port 21121 may not be open${NC}"
        echo "  Add rule: sudo firewall-cmd --add-port=21121/tcp --permanent && sudo firewall-cmd --reload"
    fi
else
    echo "  ℹ No firewall detected (ufw/firewalld)"
fi
echo ""

echo -e "${YELLOW}═══ Test 8: Check Recent Logs ═══${NC}"
echo "  Looking for sysinfo-related log entries..."
if journalctl -u betterdesk-console --no-pager -n 100 2>/dev/null | grep -i "sysinfo\|21121\|API" | tail -10; then
    :
elif journalctl -u rustdesk-console --no-pager -n 100 2>/dev/null | grep -i "sysinfo\|21121\|API" | tail -10; then
    :
else
    echo "  No relevant logs found in journalctl"
    echo "  Check: /var/log/betterdesk/*.log or process stdout"
fi
echo ""

echo -e "${YELLOW}═══ Test 9: Check External Connectivity ═══${NC}"
PUBLIC_IP=$(curl -s ifconfig.me 2>/dev/null || echo "unknown")
echo "  Your public IP: $PUBLIC_IP"
echo ""
echo "  To test from outside, run this on another machine:"
echo -e "${BLUE}  curl -X POST http://$PUBLIC_IP:21121/api/sysinfo -H 'Content-Type: application/json' -d '{\"id\":\"test\"}'${NC}"
echo ""

echo -e "${YELLOW}═══ Test 10: Check peers table for registered devices ═══${NC}"
# First find peers/peer table
PEERS_TABLE=$(sqlite3 "$DB_PATH" "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('peers', 'peer');" 2>/dev/null | head -1)
if [ -n "$PEERS_TABLE" ]; then
    echo "  Using table: $PEERS_TABLE"
    PEER_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM $PEERS_TABLE;" 2>/dev/null || echo "0")
    if [ "$PEER_COUNT" -gt 0 ] 2>/dev/null; then
        echo -e "${GREEN}✓ Found $PEER_COUNT registered device(s) in $PEERS_TABLE${NC}"
        sqlite3 "$DB_PATH" "SELECT id FROM $PEERS_TABLE LIMIT 5;" 2>/dev/null | while read -r pid; do
            echo "    - $pid"
        done
    else
        echo -e "${YELLOW}⚠ No devices found in $PEERS_TABLE${NC}"
        echo "  Note: Device must be registered before sysinfo can be stored"
    fi
else
    echo -e "${YELLOW}⚠ No peers/peer table found${NC}"
fi
echo ""

echo -e "${BLUE}══════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}                    DIAGNOSTIC SUMMARY                         ${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════════════════${NC}"
echo ""
echo "If sysinfo is not being stored, check:"
echo "  1. RustDesk client has 'API Server' set to http://YOUR_IP:21121"
echo "  2. Client is logged in to a BetterDesk account"
echo "  3. Port 21121 is open in firewall"
echo "  4. Device exists in peers table (register first)"
echo "  5. RustDesk client version >= 1.2.0"
echo ""
echo "To force sysinfo upload from client:"
echo "  - Restart RustDesk client"
echo "  - Or: Settings > About > click 'Update' (triggers sync)"
echo ""
