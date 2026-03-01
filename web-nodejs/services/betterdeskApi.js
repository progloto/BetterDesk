/**
 * BetterDesk Console - BetterDesk Go Server API Client
 * Full client for the BetterDesk Go server REST API (34+ endpoints).
 * Used when serverBackend is set to 'betterdesk'.
 *
 * Auth: X-API-Key header (reads the same .api_key file as hbbs).
 * The Go server accepts X-API-Key for all authenticated endpoints.
 */

const axios = require('axios');
const https = require('https');
const config = require('../config/config');

// Axios instance for BetterDesk Go API
// Allow self-signed certificates for local TLS connections
const apiClient = axios.create({
    baseURL: config.betterdeskApiUrl,
    timeout: config.betterdeskApiTimeout,
    headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.betterdeskApiKey
    },
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
});

// ---------------------------------------------------------------------------
// Helper: normalise Go API flat responses into { success, data } shape
// that the Node.js panel expects.
// ---------------------------------------------------------------------------
function wrap(data) {
    if (data && typeof data === 'object' && 'error' in data) {
        return { success: false, error: data.error };
    }
    return { success: true, data };
}

// ========================== Health / Stats ==================================

/**
 * GET /api/health
 */
async function getHealth() {
    try {
        const { data } = await apiClient.get('/health');
        // Go server returns status:'ok'; normalise to status:'running' for panel compatibility
        return { ...data, status: 'running', backend: 'betterdesk' };
    } catch (err) {
        return { status: 'unreachable', backend: 'betterdesk', error: err.message };
    }
}

/**
 * GET /api/server/stats
 */
async function getServerStats() {
    try {
        const { data } = await apiClient.get('/server/stats');
        return wrap(data);
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// ========================== Peers (Devices) =================================

/**
 * GET /api/peers  — full device list
 * Returns array of peer objects already normalised.
 */
async function getAllPeers() {
    try {
        const { data } = await apiClient.get('/peers');
        // Go server returns flat array or { peers: [...] }
        const peers = Array.isArray(data) ? data : (data.peers || []);
        return peers.map(normalisePeer);
    } catch (err) {
        console.warn('BetterDesk API getAllPeers error:', err.message);
        return [];
    }
}

/**
 * GET /api/peers/:id
 */
async function getPeer(id) {
    try {
        const { data } = await apiClient.get(`/peers/${encodeURIComponent(id)}`);
        return normalisePeer(data);
    } catch (err) {
        return null;
    }
}

/**
 * DELETE /api/peers/:id
 */
async function deletePeer(id) {
    try {
        const { data } = await apiClient.delete(`/peers/${encodeURIComponent(id)}`);
        return wrap(data);
    } catch (err) {
        if (err.response?.data) return wrap(err.response.data);
        return { success: false, error: err.message };
    }
}

/**
 * POST /api/peers/:id/ban
 */
async function banPeer(id, reason = '') {
    try {
        const { data } = await apiClient.post(`/peers/${encodeURIComponent(id)}/ban`, { reason });
        return wrap(data);
    } catch (err) {
        if (err.response?.data) return wrap(err.response.data);
        return { success: false, error: err.message };
    }
}

/**
 * POST /api/peers/:id/unban
 */
async function unbanPeer(id) {
    try {
        const { data } = await apiClient.post(`/peers/${encodeURIComponent(id)}/unban`);
        return wrap(data);
    } catch (err) {
        if (err.response?.data) return wrap(err.response.data);
        return { success: false, error: err.message };
    }
}

/**
 * POST /api/peers/:id/change-id
 */
async function changePeerId(oldId, newId) {
    try {
        const { data } = await apiClient.post(`/peers/${encodeURIComponent(oldId)}/change-id`, { new_id: newId });
        return wrap(data);
    } catch (err) {
        if (err.response?.data) return wrap(err.response.data);
        return { success: false, error: err.message };
    }
}

// ========================== Status ==========================================

/**
 * GET /api/peers/status/summary
 */
async function getStatusSummary() {
    try {
        const { data } = await apiClient.get('/peers/status/summary');
        return wrap(data);
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/**
 * GET /api/peers/online
 */
async function getOnlinePeers() {
    try {
        const { data } = await apiClient.get('/peers/online');
        const peers = Array.isArray(data) ? data : (data.peers || []);
        return peers;
    } catch (err) {
        console.warn('BetterDesk API getOnlinePeers error:', err.message);
        return [];
    }
}

/**
 * GET /api/peers/:id/status
 */
async function getPeerStatus(id) {
    try {
        const { data } = await apiClient.get(`/peers/${encodeURIComponent(id)}/status`);
        return wrap(data);
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// ========================== Blocklist ========================================

/**
 * GET /api/blocklist
 */
async function getBlocklist() {
    try {
        const { data } = await apiClient.get('/blocklist');
        return wrap(data);
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/**
 * POST /api/blocklist
 */
async function addBlocklistEntry(entry) {
    try {
        const { data } = await apiClient.post('/blocklist', { entry });
        return wrap(data);
    } catch (err) {
        if (err.response?.data) return wrap(err.response.data);
        return { success: false, error: err.message };
    }
}

/**
 * DELETE /api/blocklist/:entry
 */
async function removeBlocklistEntry(entry) {
    try {
        const { data } = await apiClient.delete(`/blocklist/${encodeURIComponent(entry)}`);
        return wrap(data);
    } catch (err) {
        if (err.response?.data) return wrap(err.response.data);
        return { success: false, error: err.message };
    }
}

// ========================== Tags =============================================

/**
 * PUT /api/peers/:id/tags
 */
async function setPeerTags(id, tags) {
    try {
        const { data } = await apiClient.put(`/peers/${encodeURIComponent(id)}/tags`, { tags });
        return wrap(data);
    } catch (err) {
        if (err.response?.data) return wrap(err.response.data);
        return { success: false, error: err.message };
    }
}

/**
 * GET /api/tags/:tag/peers
 */
async function getPeersByTag(tag) {
    try {
        const { data } = await apiClient.get(`/tags/${encodeURIComponent(tag)}/peers`);
        const peers = Array.isArray(data) ? data : (data.peers || []);
        return peers.map(normalisePeer);
    } catch (err) {
        return [];
    }
}

// ========================== Audit ============================================

/**
 * GET /api/audit/events?limit=N
 */
async function getAuditEvents(limit = 100) {
    try {
        const { data } = await apiClient.get('/audit/events', { params: { limit } });
        return wrap(data);
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// ========================== Config ===========================================

/**
 * GET /api/config/:key
 */
async function getConfig(key) {
    try {
        const { data } = await apiClient.get(`/config/${encodeURIComponent(key)}`);
        return wrap(data);
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/**
 * PUT /api/config/:key
 */
async function setConfig(key, value) {
    try {
        const { data } = await apiClient.put(`/config/${encodeURIComponent(key)}`, { value });
        return wrap(data);
    } catch (err) {
        if (err.response?.data) return wrap(err.response.data);
        return { success: false, error: err.message };
    }
}

// ========================== Server Info ======================================

/**
 * Combined server info for the panel settings page
 */
async function getServerInfo() {
    try {
        const [healthRes, statsRes] = await Promise.all([
            apiClient.get('/health').catch(() => ({ data: {} })),
            apiClient.get('/server/stats').catch(() => ({ data: {} }))
        ]);
        return {
            health: healthRes.data,
            stats: statsRes.data,
            backend: 'betterdesk'
        };
    } catch (err) {
        return null;
    }
}

// ========================== Sync (no-op for BetterDesk) ======================

/**
 * In BetterDesk mode the Go server owns the peer map, so status sync
 * is not needed. This is a no-op kept for interface compatibility.
 */
async function syncOnlineStatus(/* db */) {
    return { synced: 0, skipped: true, reason: 'betterdesk_manages_state' };
}

// ========================== Helpers ==========================================

/**
 * Normalise a Go-server peer object to the shape the panel expects.
 *
 * Go server /api/peers returns (see db.Peer struct + peerResponse):
 *   id, uuid, pk, ip, user, hostname, os, version, status,
 *   nat_type, last_online, created_at, disabled, banned,
 *   ban_reason, banned_at, soft_deleted, deleted_at, note, tags,
 *   live_online (bool), live_status ("online"|"degraded"|"critical"|"offline")
 *
 * Panel expected shape: id, hostname, username, platform, ip, note,
 *   online (bool), banned (bool), created_at, last_online, ban_reason,
 *   folder_id, tags[], status_tier, uuid, disabled, os, version
 */
function normalisePeer(peer) {
    if (!peer) return peer;

    // Parse tags: Go server sends comma-separated string or JSON array
    let tags = [];
    if (Array.isArray(peer.tags)) {
        tags = peer.tags;
    } else if (typeof peer.tags === 'string' && peer.tags) {
        try {
            const parsed = JSON.parse(peer.tags);
            tags = Array.isArray(parsed) ? parsed : [peer.tags];
        } catch {
            tags = peer.tags.split(',').map(t => t.trim()).filter(Boolean);
        }
    }

    return {
        id: peer.id || '',
        hostname: peer.hostname || '',
        username: peer.user || '',
        platform: peer.os || '',
        os: peer.os || '',
        version: peer.version || '',
        ip: peer.ip || '',
        note: peer.note || '',
        online: !!(peer.live_online),
        banned: !!(peer.banned),
        created_at: peer.created_at || '',
        last_online: peer.last_online || '',
        ban_reason: peer.ban_reason || '',
        banned_at: peer.banned_at || null,
        folder_id: peer.folder_id || null,
        tags,
        status_tier: peer.live_status || (peer.live_online ? 'online' : 'offline'),
        uuid: peer.uuid || '',
        nat_type: peer.nat_type || 0,
        disabled: !!(peer.disabled || peer.soft_deleted)
    };
}

module.exports = {
    // Health / Stats
    getHealth,
    getServerStats,
    getServerInfo,
    // Peers
    getAllPeers,
    getPeer,
    deletePeer,
    banPeer,
    unbanPeer,
    changePeerId,
    // Status
    getStatusSummary,
    getOnlinePeers,
    getPeerStatus,
    // Blocklist
    getBlocklist,
    addBlocklistEntry,
    removeBlocklistEntry,
    // Tags
    setPeerTags,
    getPeersByTag,
    // Audit
    getAuditEvents,
    // Config
    getConfig,
    setConfig,
    // Sync (no-op)
    syncOnlineStatus,
    // Helpers
    normalisePeer
};
