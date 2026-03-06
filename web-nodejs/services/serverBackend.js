/**
 * BetterDesk Console - Server Backend Abstraction Layer
 *
 * Provides a unified interface for device/peer operations.
 * Always uses BetterDesk Go server (betterdesk mode).
 *
 * Legacy 'rustdesk' (hbbs/hbbr) backend has been removed.
 * All operations delegate to betterdeskApi.js (Go server REST API).
 *
 * The active backend is always 'betterdesk'.
 */

const config = require('../config/config');
const db = require('./database');
const betterdeskApi = require('./betterdeskApi');

/**
 * Return the active backend name: always 'betterdesk'
 */
async function getActiveBackend() {
    return 'betterdesk';
}

/**
 * Change the active backend. Only 'betterdesk' is supported.
 * @param {'betterdesk'} name
 */
async function setActiveBackend(name) {
    if (name !== 'betterdesk') {
        throw new Error(`Invalid backend: ${name}. Only 'betterdesk' is supported.`);
    }
    await db.setSetting('server_backend', name);
}

/**
 * Returns true — always BetterDesk (Go server).
 */
async function isBetterDesk() {
    return true;
}

// ========================== Health / Stats ===================================

async function getHealth() {
    return betterdeskApi.getHealth();
}

async function getStats() {
    const result = await betterdeskApi.getServerStats();
    if (result.success && result.data) {
        // Normalise Go shape → panel shape
        const d = result.data;
        const total = d.peers_total ?? d.total_peers ?? d.total ?? 0;
        const online = d.peers_online ?? d.peers_online_live ?? d.online_peers ?? d.online ?? 0;
        return {
            total,
            online,
            offline: total - online,
            banned: d.peers_banned ?? d.banned_peers ?? d.banned ?? 0,
            withNotes: d.with_notes ?? 0
        };
    }
    // Fallthrough: fetch from local DB as fallback
    return await db.getStats();
}

async function getServerInfo() {
    return betterdeskApi.getServerInfo();
}

// ========================== Devices / Peers ==================================

async function getAllDevices(filters = {}) {
    if (await isBetterDesk()) {
        let peers = await betterdeskApi.getAllPeers();

        // Overlay folder_id from auth.db assignments (Go server doesn't track folders)
        try {
            const assignments = await db.getAllFolderAssignments();
            for (const peer of peers) {
                if (assignments[peer.id] !== undefined) {
                    peer.folder_id = assignments[peer.id];
                }
            }
        } catch (err) {
            // Non-critical: folders simply won't be assigned
            console.error('Failed to overlay folder assignments:', err.message);
        }

        // Apply client-side filtering (the Go API may not support all filter params)
        if (filters.search) {
            const s = filters.search.toLowerCase();
            peers = peers.filter(p =>
                (p.id && p.id.toLowerCase().includes(s)) ||
                (p.username && p.username.toLowerCase().includes(s)) ||
                (p.hostname && p.hostname.toLowerCase().includes(s)) ||
                (p.note && p.note.toLowerCase().includes(s))
            );
        }
        if (filters.status === 'online') {
            peers = peers.filter(p => p.online);
        } else if (filters.status === 'offline') {
            peers = peers.filter(p => !p.online && !p.banned);
        } else if (filters.status === 'banned') {
            peers = peers.filter(p => p.banned);
        }
        if (filters.hasNotes) {
            peers = peers.filter(p => p.note && p.note.trim() !== '');
        }
        // Sort
        const col = filters.sortBy || 'last_online';
        const asc = filters.sortOrder === 'asc';
        peers.sort((a, b) => {
            const va = a[col] || '';
            const vb = b[col] || '';
            return asc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
        });
        return peers;
    }
    return await db.getAllDevices(filters);
}

async function getDeviceById(id) {
    const peer = await betterdeskApi.getPeer(id);
    // Overlay folder_id from auth.db
    if (peer) {
        try {
            const assignments = await db.getAllFolderAssignments();
            if (assignments[peer.id] !== undefined) {
                peer.folder_id = assignments[peer.id];
            }
        } catch { /* non-critical */ }
    }
    return peer;
}

async function deleteDevice(id) {
    return betterdeskApi.deletePeer(id);
}

async function setBanStatus(id, banned, reason = '') {
    return banned
        ? betterdeskApi.banPeer(id, reason)
        : betterdeskApi.unbanPeer(id);
}

async function updateDevice(id, data) {
    // BetterDesk Go server does not expose a peer-update endpoint for user/note,
    // so we keep writing to the local SQLite in both modes for now.
    return await db.updateDevice(id, data);
}

async function changePeerId(oldId, newId) {
    return betterdeskApi.changePeerId(oldId, newId);
}

// ========================== Online Status Sync ===============================

async function syncOnlineStatus() {
    // BetterDesk Go server owns the peer map — no sync needed.
    return betterdeskApi.syncOnlineStatus();
}

// ========================== BetterDesk Features ==============================

async function getStatusSummary() {
    return betterdeskApi.getStatusSummary();
}

async function getBlocklist() {
    return betterdeskApi.getBlocklist();
}

async function addBlocklistEntry(entry) {
    return betterdeskApi.addBlocklistEntry(entry);
}

async function removeBlocklistEntry(entry) {
    return betterdeskApi.removeBlocklistEntry(entry);
}

async function setPeerTags(id, tags) {
    return betterdeskApi.setPeerTags(id, tags);
}

async function getPeersByTag(tag) {
    return betterdeskApi.getPeersByTag(tag);
}

async function getAuditEvents(limit) {
    return betterdeskApi.getAuditEvents(limit);
}

module.exports = {
    // Backend management
    getActiveBackend,
    setActiveBackend,
    isBetterDesk,
    // Health / Stats
    getHealth,
    getStats,
    getServerInfo,
    // Devices
    getAllDevices,
    getDeviceById,
    deleteDevice,
    setBanStatus,
    updateDevice,
    changePeerId,
    // Status sync
    syncOnlineStatus,
    // BetterDesk-only
    getStatusSummary,
    getBlocklist,
    addBlocklistEntry,
    removeBlocklistEntry,
    setPeerTags,
    getPeersByTag,
    getAuditEvents
};
