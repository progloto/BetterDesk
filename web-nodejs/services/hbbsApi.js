/**
 * BetterDesk Console - HBBS API Client
 * Communicates with HBBS server REST API
 */

const axios = require('axios');
const https = require('https');
const config = require('../config/config');

// Normalize base URL — ensure /api suffix is present.
// Users commonly set HBBS_API_URL=http://host:21114 instead of http://host:21114/api
let baseUrl = config.hbbsApiUrl || 'http://localhost:21114/api';
if (!baseUrl.endsWith('/api') && !baseUrl.endsWith('/api/')) {
    baseUrl = baseUrl.replace(/\/+$/, '') + '/api';
}

// Create axios instance with defaults
// Allow self-signed certificates for local TLS connections
const apiClient = axios.create({
    baseURL: baseUrl,
    timeout: config.hbbsApiTimeout,
    headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.hbbsApiKey
    },
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
});

/**
 * Check API health
 */
async function getHealth() {
    try {
        const { data } = await apiClient.get('/health');
        return { status: 'running', ...data };
    } catch (err) {
        return { status: 'unreachable', error: err.message };
    }
}

/**
 * Get online peers from HBBS API.
 * Handles two response formats:
 *   1. Bare array: [{id, live_online, ...}, ...]  (BetterDesk patched hbbs)
 *   2. Wrapped:    {success: true, data: [...]}   (standard hbbs API)
 * Online field may be `live_online` or `online`.
 */
async function getOnlinePeers() {
    try {
        const { data } = await apiClient.get('/peers');
        const peers = Array.isArray(data)
            ? data
            : (data && data.success && Array.isArray(data.data) ? data.data : []);
        return peers.filter(p => p.live_online || p.online);
    } catch (err) {
        console.warn('HBBS API unavailable:', err.message);
        return [];
    }
}

/**
 * Get peer details from HBBS API
 */
async function getPeer(id) {
    try {
        const { data } = await apiClient.get(`/peers/${id}`);
        return data;
    } catch (err) {
        return null;
    }
}

/**
 * Change peer ID
 */
async function changePeerId(oldId, newId) {
    try {
        const { data } = await apiClient.post(`/peers/${oldId}/change-id`, { new_id: newId });
        return data;
    } catch (err) {
        if (err.response?.data) {
            return err.response.data;
        }
        throw err;
    }
}

/**
 * Delete peer via API
 */
async function deletePeer(id) {
    try {
        const { data } = await apiClient.delete(`/peers/${id}`);
        return data;
    } catch (err) {
        if (err.response?.data) {
            return err.response.data;
        }
        throw err;
    }
}

/**
 * Get server info
 */
async function getServerInfo() {
    try {
        const { data } = await apiClient.get('/server/info');
        return data;
    } catch (err) {
        return null;
    }
}

/**
 * Sync online status from HBBS API to database
 */
async function syncOnlineStatus(db) {
    try {
        const onlinePeers = await getOnlinePeers();
        
        // If API returned empty AND health check fails, skip reset
        // This prevents marking all devices offline when HBBS is unreachable
        if (onlinePeers.length === 0) {
            const health = await getHealth();
            if (health.status !== 'running') {
                console.warn('HBBS API unreachable - skipping status sync to preserve current state');
                return { synced: 0, skipped: true, reason: 'api_unreachable' };
            }
        }
        
        const onlineIds = new Set(onlinePeers.map(p => p.id));
        
        // Reset all to offline
        db.prepare('UPDATE peer SET status_online = 0').run();
        
        // Set online for those from API
        if (onlineIds.size > 0) {
            const placeholders = Array(onlineIds.size).fill('?').join(',');
            db.prepare(`UPDATE peer SET status_online = 1, last_online = datetime('now') WHERE id IN (${placeholders})`)
                .run(...onlineIds);
        }
        
        return { synced: onlineIds.size };
    } catch (err) {
        console.warn('Failed to sync online status:', err.message);
        return { synced: 0, error: err.message };
    }
}

module.exports = {
    getHealth,
    getOnlinePeers,
    getPeer,
    changePeerId,
    deletePeer,
    getServerInfo,
    syncOnlineStatus
};
