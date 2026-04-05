/**
 * BetterDesk Console — CDAP Terminal WebSocket Proxy
 * Proxies terminal WebSocket connections from the browser to the Go server's
 * CDAP terminal endpoint.  Authenticates via session cookie.
 *
 * Browser  ←WS→  Node.js (:5000)  ←WS→  Go API (:21114)
 *    /api/cdap/devices/:id/terminal  →  /api/cdap/devices/:id/terminal
 */

const WebSocket = require('ws');
const config = require('../config/config');

/**
 * Initialize the CDAP terminal WebSocket proxy and attach to HTTP server.
 * @param {import('http').Server} server
 * @param {Function} sessionMiddleware - Express session middleware for auth
 */
function initCdapTerminalProxy(server, sessionMiddleware) {
    const wss = new WebSocket.Server({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathname = url.pathname;

        // Match /api/cdap/devices/:id/terminal
        const match = pathname.match(/^\/api\/cdap\/devices\/([A-Za-z0-9_-]{6,30})\/terminal$/);
        if (!match) return; // Let other upgrade handlers deal with it

        const deviceId = match[1];

        // Require session authentication
        sessionMiddleware(req, {}, () => {
            if (!req.session || !req.session.userId) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }

            // RBAC: only admin users can access terminal
            if (req.session.role !== 'admin') {
                socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
                socket.destroy();
                return;
            }

            wss.handleUpgrade(req, socket, head, (ws) => {
                wss.emit('connection', ws, req, deviceId);
            });
        });
    });

    wss.on('connection', (browserWs, req, deviceId) => {
        const username = req.session?.username || 'admin';
        console.log(`[CDAP Terminal] Proxy session started for device ${deviceId} by ${username}`);

        // Build Go server WebSocket URL
        const goApiBase = config.betterdeskApiUrl || 'http://localhost:21114/api';
        const goWsUrl = goApiBase
            .replace(/^http/, 'ws')
            .replace(/\/api\/?$/, '') +
            `/api/cdap/devices/${encodeURIComponent(deviceId)}/terminal`;

        // Connect to Go server terminal endpoint
        const goWs = new WebSocket(goWsUrl, ['cdap-terminal'], {
            headers: {
                'X-API-Key': config.betterdeskApiKey || '',
                'X-Username': username,
                'X-Role': req.session?.role || 'admin'
            },
            // Allow self-signed certs for local Go server
            rejectUnauthorized: !config.allowSelfSignedCerts
        });

        let goConnected = false;

        goWs.on('open', () => {
            goConnected = true;
        });

        // Relay: Browser → Go
        browserWs.on('message', (data) => {
            if (goConnected && goWs.readyState === WebSocket.OPEN) {
                goWs.send(data);
            }
        });

        // Relay: Go → Browser
        goWs.on('message', (data) => {
            if (browserWs.readyState === WebSocket.OPEN) {
                browserWs.send(data);
            }
        });

        // Handle disconnection
        browserWs.on('close', () => {
            console.log(`[CDAP Terminal] Browser disconnected for device ${deviceId}`);
            if (goWs.readyState === WebSocket.OPEN || goWs.readyState === WebSocket.CONNECTING) {
                goWs.close();
            }
        });

        goWs.on('close', () => {
            if (browserWs.readyState === WebSocket.OPEN) {
                browserWs.close();
            }
        });

        goWs.on('error', (err) => {
            console.error(`[CDAP Terminal] Go server WS error for ${deviceId}:`, err.message);
            if (browserWs.readyState === WebSocket.OPEN) {
                browserWs.send(JSON.stringify({ type: 'error', error: 'Server connection failed' }));
                browserWs.close();
            }
        });

        browserWs.on('error', (err) => {
            console.error(`[CDAP Terminal] Browser WS error for ${deviceId}:`, err.message);
            if (goWs.readyState === WebSocket.OPEN) {
                goWs.close();
            }
        });
    });

    console.log('[CDAP Terminal] WebSocket proxy initialized (/api/cdap/devices/:id/terminal)');
    return wss;
}

module.exports = { initCdapTerminalProxy };
