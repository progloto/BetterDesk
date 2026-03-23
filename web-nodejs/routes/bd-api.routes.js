/**
 * BetterDesk Console — Desktop Client API Routes
 *
 * REST endpoints consumed by the BetterDesk desktop client (Tauri).
 * These run on the main console server (port 5000) under /api/bd/*.
 *
 * Endpoints:
 *   POST   /api/bd/register     — Register / heartbeat a desktop device
 *   POST   /api/bd/connect      — Request relay session to a target device
 *   GET    /api/bd/session/:id  — Check session status
 *   POST   /api/bd/heartbeat    — Lightweight keepalive
 *   GET    /api/bd/peers        — List online peers (requires auth)
 *   GET    /api/bd/peer/:id     — Get single peer info
 *   DELETE /api/bd/session/:id  — Cancel/close a relay session
 *
 * Authentication:
 *   Desktop clients authenticate via access tokens (Bearer header) obtained
 *   from the RustDesk Client API (/api/login on port 21121).
 *   Token is validated with the same authService.
 *
 * @author UNITRONIX
 * @version 1.0.0
 */

'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../services/database');
const bdRelay = require('../services/bdRelay');
const brandingService = require('../services/brandingService');
const authService = require('../services/authService');

// ---------------------------------------------------------------------------
//  In-memory help-request store (survives restarts via audit log for history)
// ---------------------------------------------------------------------------

/** @type {Map<string, Object>} */
const helpRequests = new Map();

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || req.headers['x-real-ip']
        || req.socket?.remoteAddress
        || 'unknown';
}

function extractBearerToken(req) {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) return null;
    return auth.substring(7).trim();
}

// ---------------------------------------------------------------------------
//  Middleware — authenticate desktop client via access token
// ---------------------------------------------------------------------------

async function requireDeviceAuth(req, res, next) {
    const token = extractBearerToken(req);
    if (!token) {
        return res.status(401).json({ error: 'Missing authorization token' });
    }
    try {
        const tokenRow = await db.getAccessToken(token);
        if (!tokenRow) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }
        // Attach user + token info to request
        const user = await db.getUserById(tokenRow.user_id);
        req.deviceToken = tokenRow;
        req.deviceUser = user || null;
        await db.touchAccessToken(token);
        next();
    } catch (err) {
        console.error('[BD-API] Auth error:', err.message);
        res.status(500).json({ error: 'Authentication failed' });
    }
}

/**
 * Lightweight auth — token OR device_id header (for unauthenticated heartbeat).
 * Sets req.deviceId from token's client_id or from X-Device-Id header.
 */
async function identifyDevice(req, res, next) {
    const token = extractBearerToken(req);
    if (token) {
        try {
            const tokenRow = await db.getAccessToken(token);
            if (tokenRow) {
                req.deviceId = tokenRow.client_id || null;
                req.deviceToken = tokenRow;
                await db.touchAccessToken(token);
                return next();
            }
        } catch (_) {}
    }
    // Fallback: X-Device-Id header (for registration before login)
    const deviceId = req.headers['x-device-id'];
    if (deviceId && /^[A-Za-z0-9_-]{3,32}$/.test(deviceId)) {
        req.deviceId = deviceId;
        return next();
    }
    return res.status(401).json({ error: 'Missing device identification' });
}

// ---------------------------------------------------------------------------
//  POST /api/bd/register — Register or update a desktop device
// ---------------------------------------------------------------------------

router.post('/register', identifyDevice, async (req, res) => {
    try {
        const ip = getClientIp(req);
        const { device_id, uuid, hostname, platform, version, public_key } = req.body;

        const id = device_id || req.deviceId;
        if (!id) {
            return res.status(400).json({ error: 'device_id is required' });
        }

        // Build info JSON
        const info = JSON.stringify({
            hostname: hostname || '',
            os: platform || '',
            version: version || '',
            ip: ip,
        });

        // Upsert peer in DB
        await db.upsertPeer({ id, uuid: uuid || '', pk: public_key || null, info, ip });

        // Update online status
        try {
            await db.updatePeerOnlineStatus(id);
        } catch (_) {}

        res.json({
            success: true,
            device_id: id,
            server_time: Date.now(),
            heartbeat_interval: 15, // seconds
        });
    } catch (err) {
        console.error('[BD-API] Register error:', err.message);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// ---------------------------------------------------------------------------
//  POST /api/bd/heartbeat — Lightweight keepalive
// ---------------------------------------------------------------------------

router.post('/heartbeat', identifyDevice, async (req, res) => {
    try {
        const id = req.body.device_id || req.deviceId;
        if (!id) {
            return res.status(400).json({ error: 'device_id is required' });
        }

        // Touch online status
        try {
            await db.updatePeerOnlineStatus(id);
        } catch (_) {}

        // Check for pending incoming connection requests
        const pending = [];
        for (const [sid, session] of bdRelay.activeSessions) {
            if (session.targetId === id && session.status === 'pending') {
                pending.push({
                    session_id: sid,
                    initiator_id: session.initiatorId,
                    created_at: session.createdAt,
                });
            }
        }

        res.json({
            success: true,
            server_time: Date.now(),
            pending_connections: pending,
        });
    } catch (err) {
        console.error('[BD-API] Heartbeat error:', err.message);
        res.status(500).json({ error: 'Heartbeat failed' });
    }
});

// ---------------------------------------------------------------------------
//  POST /api/bd/connect — Request relay session to a target device
// ---------------------------------------------------------------------------

router.post('/connect', requireDeviceAuth, async (req, res) => {
    try {
        const { target_id, initiator_id, public_key } = req.body;

        if (!target_id) {
            return res.status(400).json({ error: 'target_id is required' });
        }

        const srcId = initiator_id || req.deviceToken?.client_id;
        if (!srcId) {
            return res.status(400).json({ error: 'initiator_id is required' });
        }

        // Check if target exists
        const target = await db.getDeviceById(target_id);
        if (!target) {
            return res.status(404).json({ error: 'Target device not found' });
        }

        // Check if target is banned
        if (target.is_banned) {
            return res.status(403).json({ error: 'Target device is banned' });
        }

        // Create relay session
        const { sessionId, initiatorToken, targetToken } = bdRelay.createRelaySession(srcId, target_id);

        // Try to notify target via WebSocket signal channel
        const targetNotified = bdRelay.notifyTarget(target_id, {
            type: 'incoming_connection',
            session_id: sessionId,
            initiator_id: srcId,
            initiator_pk: public_key || null,
        });

        res.json({
            success: true,
            session_id: sessionId,
            token: initiatorToken,
            target_online: targetNotified,
            relay_url: `/ws/bd-relay?session=${sessionId}&token=${initiatorToken}&role=initiator`,
        });
    } catch (err) {
        console.error('[BD-API] Connect error:', err.message);
        res.status(500).json({ error: 'Connection request failed' });
    }
});

// ---------------------------------------------------------------------------
//  GET /api/bd/session/:id — Check session status
// ---------------------------------------------------------------------------

router.get('/session/:id', identifyDevice, (req, res) => {
    const session = bdRelay.getRelaySession(req.params.id);
    if (!session) {
        return res.status(404).json({ error: 'Session not found or expired' });
    }
    res.json({ success: true, session });
});

// ---------------------------------------------------------------------------
//  DELETE /api/bd/session/:id — Cancel relay session
// ---------------------------------------------------------------------------

router.delete('/session/:id', identifyDevice, (req, res) => {
    const sessionId = req.params.id;
    const session = bdRelay.getRelaySession(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    // Only participants can cancel
    const id = req.deviceId;
    if (session.initiatorId !== id && session.targetId !== id) {
        return res.status(403).json({ error: 'Not a participant of this session' });
    }
    // Teardown handled internally
    bdRelay.activeSessions.delete(sessionId);
    res.json({ success: true });
});

// ---------------------------------------------------------------------------
//  GET /api/bd/peers — List online peers
// ---------------------------------------------------------------------------

router.get('/peers', requireDeviceAuth, async (req, res) => {
    try {
        const onlineIds = bdRelay.getOnlineDeviceIds();
        const peers = [];

        for (const id of onlineIds) {
            const device = await db.getDeviceById(id);
            if (device && !device.is_banned && !device.is_deleted) {
                peers.push({
                    id: device.id,
                    hostname: device.note || '',
                    platform: '',
                    online: true,
                });
            }
        }

        res.json({ success: true, peers });
    } catch (err) {
        console.error('[BD-API] Peers error:', err.message);
        res.status(500).json({ error: 'Failed to list peers' });
    }
});

// ---------------------------------------------------------------------------
//  GET /api/bd/peer/:id — Get single peer info
// ---------------------------------------------------------------------------

router.get('/peer/:id', identifyDevice, async (req, res) => {
    try {
        const device = await db.getDeviceById(req.params.id);
        if (!device) {
            return res.status(404).json({ error: 'Device not found' });
        }
        res.json({
            success: true,
            peer: {
                id: device.id,
                hostname: device.note || '',
                online: bdRelay.isDeviceOnline(device.id),
                banned: !!device.is_banned,
            },
        });
    } catch (err) {
        console.error('[BD-API] Peer error:', err.message);
        res.status(500).json({ error: 'Failed to get peer info' });
    }
});

// ---------------------------------------------------------------------------
//  GET /api/bd/branding — Public branding for desktop client (no auth)
// ---------------------------------------------------------------------------

router.get('/branding', (req, res) => {
    try {
        const branding = brandingService.getBranding();
        res.json({
            company_name: branding.appName || 'BetterDesk',
            accent_color: branding.colors?.accentBlue || '#3b82f6',
            support_contact: branding.supportContact || '',
        });
    } catch (err) {
        console.error('[BD-API] Branding error:', err.message);
        // Return defaults on error — never block the client
        res.json({
            company_name: 'BetterDesk',
            accent_color: '#3b82f6',
            support_contact: '',
        });
    }
});

// ---------------------------------------------------------------------------
//  POST /api/bd/help-request — Desktop client requests operator assistance
// ---------------------------------------------------------------------------

router.post('/help-request', identifyDevice, async (req, res) => {
    try {
        const { device_id, hostname, message } = req.body;

        if (!device_id || typeof device_id !== 'string') {
            return res.status(400).json({ error: 'Missing device_id' });
        }

        const helpRequest = {
            id: crypto.randomUUID(),
            device_id: String(device_id).substring(0, 32),
            hostname: String(hostname || '').substring(0, 128),
            message: String(message || '').substring(0, 500),
            status: 'pending',
            created_at: Date.now(),
        };

        // Emit to all connected operator WebSocket clients
        const io = req.app.get('io');
        if (io) {
            io.emit('help-request', helpRequest);
        }

        // Store in memory for dashboard polling
        helpRequests.set(helpRequest.id, helpRequest);

        // Auto-prune: keep max 200 entries
        if (helpRequests.size > 200) {
            const oldest = [...helpRequests.keys()].slice(0, helpRequests.size - 200);
            for (const key of oldest) helpRequests.delete(key);
        }

        // Log the help request
        await db.logAction(null, 'help_request', `Help requested by ${helpRequest.device_id}: ${helpRequest.message}`, getClientIp(req));

        console.log(`[BD-API] Help request from ${helpRequest.device_id} (${helpRequest.hostname}): ${helpRequest.message}`);

        res.json({ success: true, request_id: helpRequest.id });
    } catch (err) {
        console.error('[BD-API] Help request error:', err.message);
        res.status(500).json({ error: 'Failed to process help request' });
    }
});

// ===========================================================================
//  Operator Authentication (desktop client operator mode)
// ===========================================================================

// ---------------------------------------------------------------------------
//  POST /api/bd/operator/login — Authenticate operator from desktop client
// ---------------------------------------------------------------------------

router.post('/operator/login', async (req, res) => {
    try {
        const ip = getClientIp(req);
        const { username, password, device_id } = req.body;

        if (!username || typeof username !== 'string' || !password || typeof password !== 'string') {
            return res.status(400).json({ error: 'Username and password are required' });
        }

        // Brute-force protection
        const blocked = await authService.checkBruteForce(username, ip);
        if (blocked) {
            return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
        }

        // Authenticate
        const user = await authService.authenticate(username, password);
        if (!user) {
            authService.recordAttempt(username, ip, false);
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Only admin and operator roles can use operator mode
        if (user.role !== 'admin' && user.role !== 'operator') {
            authService.recordAttempt(username, ip, false);
            return res.status(403).json({ error: 'Insufficient permissions. Admin or operator role required.' });
        }

        // Issue access token
        authService.recordAttempt(username, ip, true);
        const token = await authService.generateAccessToken(
            user.id,
            String(device_id || '').substring(0, 32),
            '',
            ip
        );
        await db.updateLastLogin(user.id);

        await db.logAction(user.id, 'operator_login', `Operator login from desktop client (${device_id || 'unknown'})`, ip);

        res.json({
            access_token: token,
            user: {
                name: user.username || user.name || username,
                role: user.role,
            },
        });
    } catch (err) {
        console.error('[BD-API] Operator login error:', err.message);
        res.status(500).json({ error: 'Authentication failed' });
    }
});

// ---------------------------------------------------------------------------
//  GET /api/bd/operator/devices — List all devices (requires operator auth)
// ---------------------------------------------------------------------------

router.get('/operator/devices', requireDeviceAuth, async (req, res) => {
    try {
        // Only admin/operator can list devices
        if (req.deviceUser && req.deviceUser.role !== 'admin' && req.deviceUser.role !== 'operator') {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }

        const peers = await db.getAllPeers({});
        const devices = peers.map((p) => {
            let hostname = '';
            let platform = '';
            try {
                const info = typeof p.info === 'string' ? JSON.parse(p.info) : (p.info || {});
                hostname = info.hostname || p.note || '';
                platform = info.os || info.platform || '';
            } catch (_) {
                hostname = p.note || '';
            }
            return {
                id: p.id,
                hostname: hostname,
                platform: platform,
                online: !!(p.status_online || p.online),
                last_online: p.last_online || '',
            };
        });

        res.json({ success: true, devices });
    } catch (err) {
        console.error('[BD-API] Operator devices error:', err.message);
        res.status(500).json({ error: 'Failed to fetch devices' });
    }
});

// ===========================================================================
//  Help Request Management (web panel operators)
// ===========================================================================

// ---------------------------------------------------------------------------
//  GET /api/bd/help-requests — List all help requests (requires auth)
// ---------------------------------------------------------------------------

router.get('/help-requests', requireDeviceAuth, async (req, res) => {
    try {
        const items = [...helpRequests.values()]
            .sort((a, b) => b.created_at - a.created_at);

        res.json({ success: true, requests: items });
    } catch (err) {
        console.error('[BD-API] List help requests error:', err.message);
        res.status(500).json({ error: 'Failed to list help requests' });
    }
});

// ---------------------------------------------------------------------------
//  POST /api/bd/help-requests/:id/accept — Accept a help request
// ---------------------------------------------------------------------------

router.post('/help-requests/:id/accept', requireDeviceAuth, async (req, res) => {
    try {
        const entry = helpRequests.get(req.params.id);
        if (!entry) {
            return res.status(404).json({ error: 'Help request not found' });
        }

        entry.status = 'accepted';
        entry.accepted_by = req.deviceUser?.username || 'operator';
        entry.accepted_at = Date.now();

        await db.logAction(
            req.deviceUser?.id || null,
            'help_request_accept',
            `Accepted help request ${entry.id} from ${entry.device_id}`,
            getClientIp(req)
        );

        res.json({ success: true, request: entry });
    } catch (err) {
        console.error('[BD-API] Accept help request error:', err.message);
        res.status(500).json({ error: 'Failed to accept help request' });
    }
});

// ---------------------------------------------------------------------------
//  POST /api/bd/help-requests/:id/resolve — Resolve a help request
// ---------------------------------------------------------------------------

router.post('/help-requests/:id/resolve', requireDeviceAuth, async (req, res) => {
    try {
        const entry = helpRequests.get(req.params.id);
        if (!entry) {
            return res.status(404).json({ error: 'Help request not found' });
        }

        entry.status = 'resolved';
        entry.resolved_by = req.deviceUser?.username || 'operator';
        entry.resolved_at = Date.now();

        await db.logAction(
            req.deviceUser?.id || null,
            'help_request_resolve',
            `Resolved help request ${entry.id} from ${entry.device_id}`,
            getClientIp(req)
        );

        res.json({ success: true, request: entry });
    } catch (err) {
        console.error('[BD-API] Resolve help request error:', err.message);
        res.status(500).json({ error: 'Failed to resolve help request' });
    }
});

// ---------------------------------------------------------------------------
//  DELETE /api/bd/help-requests/:id — Delete a help request
// ---------------------------------------------------------------------------

router.delete('/help-requests/:id', requireDeviceAuth, async (req, res) => {
    try {
        if (!helpRequests.has(req.params.id)) {
            return res.status(404).json({ error: 'Help request not found' });
        }

        helpRequests.delete(req.params.id);
        res.json({ success: true });
    } catch (err) {
        console.error('[BD-API] Delete help request error:', err.message);
        res.status(500).json({ error: 'Failed to delete help request' });
    }
});

module.exports = router;
