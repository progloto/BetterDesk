/**
 * BetterDesk Console — Instant Chat WebSocket Relay
 *
 * Bridges the BetterDesk desktop agent (Rust/Tauri) and the operator
 * browser session via a server-side message queue + WebSocket rooms.
 *
 * Endpoints:
 *   WS /ws/chat/<device_id>              — agent connection
 *   WS /ws/chat-operator/<device_id>     — operator browser connection
 *
 * Protocol (JSON text frames):
 *   Agent → Server:
 *     { "type": "hello", "device_id": "ABC" }
 *     { "type": "message", "text": "hello", "timestamp": 1234 }
 *
 *   Operator → Server:
 *     { "type": "message", "text": "hello", "operator": "admin" }
 *     { "type": "typing" }
 *
 *   Server → Both:
 *     { "type": "message", "from": "agent"|"operator", "text": "...", "timestamp": 1234 }
 *     { "type": "status", "agent_connected": true|false }
 *     { "type": "typing", "from": "agent"|"operator" }
 *     { "type": "history", "messages": [ ... ] }
 *
 * Messages are stored in-memory (ring buffer, last 500 per device).
 * The history is sent when a new participant joins.
 */

'use strict';

const WebSocket = require('ws');

// Simple console logger helpers matching project conventions
const log = {
    info:  (...a) => console.log('[Chat]', ...a),
    warn:  (...a) => console.warn('[Chat]', ...a),
    error: (...a) => console.error('[Chat]', ...a),
};

// ---------------------------------------------------------------------------
//  Constants
// ---------------------------------------------------------------------------

const HISTORY_LIMIT   = 500;   // max messages stored per device
const MAX_TEXT_BYTES  = 8192;  // max text frame size
const PING_INTERVAL   = 30000; // ms

// ---------------------------------------------------------------------------
//  State
// ---------------------------------------------------------------------------

// device_id → { agentWs: WebSocket|null, operatorWss: Set<WebSocket>, messages: Array }
const rooms = new Map();

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function getRoom(deviceId) {
    if (!rooms.has(deviceId)) {
        rooms.set(deviceId, { agentWs: null, operatorWss: new Set(), messages: [] });
    }
    return rooms.get(deviceId);
}

function appendMessage(room, msg) {
    room.messages.push(msg);
    if (room.messages.length > HISTORY_LIMIT) {
        room.messages.splice(0, room.messages.length - HISTORY_LIMIT);
    }
}

function broadcast(room, data, excludeWs = null) {
    const text = JSON.stringify(data);
    const send = (ws) => {
        if (ws && ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
            ws.send(text);
        }
    };
    if (room.agentWs) send(room.agentWs);
    room.operatorWss.forEach(send);
}

function sendTo(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

function setupPing(ws) {
    const timer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
        else clearInterval(timer);
    }, PING_INTERVAL);
    ws.on('close', () => clearInterval(timer));
}

// ---------------------------------------------------------------------------
//  Agent connection handler (/ws/chat/:device_id)
// ---------------------------------------------------------------------------

function handleAgentConnection(ws, deviceId) {
    const room = getRoom(deviceId);

    // Disconnect any previous agent
    if (room.agentWs && room.agentWs.readyState !== WebSocket.CLOSED) {
        room.agentWs.close(1001, 'New agent connected');
    }
    room.agentWs = ws;

    log.info(`Chat: agent connected for device ${deviceId}`);

    // Notify operators
    broadcast(room, { type: 'status', agent_connected: true }, ws);

    // Send history to agent
    sendTo(ws, { type: 'history', messages: room.messages });

    setupPing(ws);

    ws.on('message', (data, isBinary) => {
        if (isBinary || data.length > MAX_TEXT_BYTES) return;

        let frame;
        try { frame = JSON.parse(data.toString()); } catch { return; }

        switch (frame.type) {
            case 'hello':
                // Already handled via URL
                break;

            case 'message': {
                const msg = {
                    type: 'message',
                    id: Date.now(),
                    from: 'agent',
                    text: String(frame.text || '').slice(0, 2048),
                    timestamp: frame.timestamp || Date.now(),
                };
                appendMessage(room, msg);
                broadcast(room, msg, ws);
                break;
            }

            case 'typing':
                broadcast(room, { type: 'typing', from: 'agent' }, ws);
                break;

            default:
                break;
        }
    });

    ws.on('close', () => {
        if (room.agentWs === ws) {
            room.agentWs = null;
            log.info(`Chat: agent disconnected for device ${deviceId}`);
            broadcast(room, { type: 'status', agent_connected: false });
        }
    });

    ws.on('error', (err) => {
        log.warn(`Chat agent WS error for ${deviceId}: ${err.message}`);
    });
}

// ---------------------------------------------------------------------------
//  Operator connection handler (/ws/chat-operator/:device_id)
// ---------------------------------------------------------------------------

function handleOperatorConnection(ws, deviceId, operatorName) {
    const room = getRoom(deviceId);
    room.operatorWss.add(ws);

    log.info(`Chat: operator ${operatorName} connected to device ${deviceId}`);

    // Send history and current agent status
    sendTo(ws, { type: 'history', messages: room.messages });
    sendTo(ws, { type: 'status', agent_connected: !!room.agentWs && room.agentWs.readyState === WebSocket.OPEN });

    setupPing(ws);

    ws.on('message', (data, isBinary) => {
        if (isBinary || data.length > MAX_TEXT_BYTES) return;

        let frame;
        try { frame = JSON.parse(data.toString()); } catch { return; }

        switch (frame.type) {
            case 'message': {
                const msg = {
                    type: 'message',
                    id: Date.now(),
                    from: 'operator',
                    operator: operatorName,
                    text: String(frame.text || '').slice(0, 2048),
                    timestamp: Date.now(),
                };
                appendMessage(room, msg);
                // Send to agent + all other operators
                broadcast(room, msg, ws);
                break;
            }

            case 'typing':
                broadcast(room, { type: 'typing', from: 'operator', operator: operatorName }, ws);
                break;

            default:
                break;
        }
    });

    ws.on('close', () => {
        room.operatorWss.delete(ws);
        log.info(`Chat: operator ${operatorName} disconnected from device ${deviceId}`);
    });

    ws.on('error', (err) => {
        log.warn(`Chat operator WS error for ${deviceId}: ${err.message}`);
    });
}

// ---------------------------------------------------------------------------
//  Init — attach to existing HTTP server
// ---------------------------------------------------------------------------

function initChatRelay(server, sessionMiddleware) {
    const wss = new WebSocket.Server({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathname = url.pathname;

        // Agent endpoint: /ws/chat/<device_id>
        const agentMatch = pathname.match(/^\/ws\/chat\/([^/]+)$/);
        if (agentMatch) {
            wss.handleUpgrade(req, socket, head, (ws) => {
                wss.emit('connection', ws, req, 'agent', agentMatch[1]);
            });
            return;
        }

        // Operator endpoint: /ws/chat-operator/<device_id>
        const opMatch = pathname.match(/^\/ws\/chat-operator\/([^/]+)$/);
        if (opMatch) {
            // Require session authentication for operators
            sessionMiddleware(req, {}, () => {
                if (!req.session || !req.session.userId) {
                    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                    socket.destroy();
                    return;
                }
                wss.handleUpgrade(req, socket, head, (ws) => {
                    wss.emit('connection', ws, req, 'operator', opMatch[1]);
                });
            });
            return;
        }
    });

    wss.on('connection', (ws, req, role, deviceId) => {
        if (role === 'agent') {
            handleAgentConnection(ws, deviceId);
        } else {
            // Extract operator name from session
            sessionMiddleware(req, {}, () => {
                const operatorName = req.session?.username || 'operator';
                handleOperatorConnection(ws, deviceId, operatorName);
            });
        }
    });

    log.info('Chat WebSocket relay initialized (/ws/chat/:id, /ws/chat-operator/:id)');
    return wss;
}

// ---------------------------------------------------------------------------
//  Exports
// ---------------------------------------------------------------------------

module.exports = {
    initChatRelay,
    /** Get chat room state (for admin REST API) */
    getRoomState(deviceId) {
        const room = rooms.get(deviceId);
        if (!room) return null;
        return {
            agentConnected: !!room.agentWs && room.agentWs.readyState === WebSocket.OPEN,
            operatorCount: room.operatorWss.size,
            messageCount: room.messages.length,
            lastMessages: room.messages.slice(-20),
        };
    },
    getRooms: () => [...rooms.keys()],
};
