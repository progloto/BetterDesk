/**
 * BetterDesk Console — CDAP Media WebSocket Proxy
 * Proxies desktop/video/file-browser WebSocket connections from the
 * browser to the Go server's CDAP endpoints.
 *
 * Browser  ←WS→  Node.js (:5000)  ←WS→  Go API (:21114)
 */

const WebSocket = require('ws');
const config = require('../config/config');

/**
 * Create a CDAP media proxy for a specific channel type.
 * @param {import('http').Server} server
 * @param {Function} sessionMiddleware
 * @param {object} opts
 * @param {string} opts.channel     - URL segment: desktop, video, files
 * @param {string} opts.subprotocol - WebSocket subprotocol name
 * @param {string} opts.minRole     - Minimum required role: admin, operator, viewer
 * @param {string} opts.label       - Log label
 */
function createCdapMediaProxy(server, sessionMiddleware, opts) {
    const { channel, subprotocol, minRole, label } = opts;

    const pattern = new RegExp(
        `^\\/api\\/cdap\\/devices\\/([A-Za-z0-9_-]{1,64})\\/${channel}$`
    );

    const roleLevel = { admin: 3, operator: 2, viewer: 1 };

    const wss = new WebSocket.Server({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const match = url.pathname.match(pattern);
        if (!match) return;

        const deviceId = match[1];

        sessionMiddleware(req, {}, () => {
            if (!req.session || !req.session.userId) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }

            const userLevel = roleLevel[req.session.role] || 0;
            const requiredLevel = roleLevel[minRole] || 3;
            if (userLevel < requiredLevel) {
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
        console.log(`[CDAP ${label}] Proxy started for device ${deviceId} by ${username}`);

        const goApiBase = config.betterdeskApiUrl || 'http://localhost:21114/api';
        const goWsUrl = goApiBase
            .replace(/^http/, 'ws')
            .replace(/\/api\/?$/, '') +
            `/api/cdap/devices/${encodeURIComponent(deviceId)}/${channel}`;

        const goWs = new WebSocket(goWsUrl, [subprotocol], {
            headers: {
                'X-API-Key': config.betterdeskApiKey || '',
                'X-Username': username,
                'X-Role': req.session?.role || 'admin'
            },
            rejectUnauthorized: !config.allowSelfSignedCerts
        });

        let goConnected = false;

        goWs.on('open', () => { goConnected = true; });

        browserWs.on('message', (data) => {
            if (goConnected && goWs.readyState === WebSocket.OPEN) {
                goWs.send(data);
            }
        });

        goWs.on('message', (data) => {
            if (browserWs.readyState === WebSocket.OPEN) {
                browserWs.send(data);
            }
        });

        browserWs.on('close', () => {
            console.log(`[CDAP ${label}] Browser disconnected for device ${deviceId}`);
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
            console.error(`[CDAP ${label}] Go WS error for ${deviceId}:`, err.message);
            if (browserWs.readyState === WebSocket.OPEN) {
                browserWs.send(JSON.stringify({ type: 'error', error: 'Server connection failed' }));
                browserWs.close();
            }
        });

        browserWs.on('error', (err) => {
            console.error(`[CDAP ${label}] Browser WS error for ${deviceId}:`, err.message);
            if (goWs.readyState === WebSocket.OPEN) {
                goWs.close();
            }
        });
    });

    return wss;
}

/**
 * Initialize all CDAP media WebSocket proxies (desktop, video, file browser).
 * @param {import('http').Server} server
 * @param {Function} sessionMiddleware
 */
function initCdapMediaProxies(server, sessionMiddleware) {
    createCdapMediaProxy(server, sessionMiddleware, {
        channel: 'desktop',
        subprotocol: 'cdap-desktop',
        minRole: 'admin',
        label: 'Desktop'
    });

    createCdapMediaProxy(server, sessionMiddleware, {
        channel: 'video',
        subprotocol: 'cdap-video',
        minRole: 'operator',
        label: 'Video'
    });

    createCdapMediaProxy(server, sessionMiddleware, {
        channel: 'files',
        subprotocol: 'cdap-filebrowser',
        minRole: 'admin',
        label: 'FileBrowser'
    });

    createCdapMediaProxy(server, sessionMiddleware, {
        channel: 'audio',
        subprotocol: 'cdap-audio',
        minRole: 'operator',
        label: 'Audio'
    });

    console.log('[CDAP Media] WebSocket proxies initialized (desktop, video, files, audio)');
}

module.exports = { initCdapMediaProxies };
