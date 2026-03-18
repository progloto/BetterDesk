/**
 * BetterDesk Console - Devices Routes
 */

const express = require('express');
const router = express.Router();
const db = require('../services/database');
const serverBackend = require('../services/serverBackend');
const { requireAuth, requireRole } = require('../middleware/auth');

/**
 * GET /devices - Devices list page
 */
router.get('/devices', requireAuth, (req, res) => {
    res.render('devices', {
        title: req.t('nav.devices'),
        activePage: 'devices'
    });
});

/**
 * GET /api/devices - Get devices list (JSON)
 */
// Allowed values for sort parameters (prevent SQL injection via sort columns)
const ALLOWED_SORT_FIELDS = ['last_online', 'id', 'hostname', 'created_at', 'os', 'version', 'username', 'note'];
const ALLOWED_SORT_ORDERS = ['asc', 'desc'];

router.get('/api/devices', requireAuth, async (req, res) => {
    try {
        // Validate and sanitize sort parameters
        const sortBy = ALLOWED_SORT_FIELDS.includes(req.query.sortBy) 
            ? req.query.sortBy : 'last_online';
        const sortOrder = ALLOWED_SORT_ORDERS.includes(req.query.sortOrder?.toLowerCase()) 
            ? req.query.sortOrder.toLowerCase() : 'desc';
        
        const filters = {
            search: req.query.search || '',
            status: req.query.status || '',
            hasNotes: req.query.hasNotes === 'true',
            sortBy,
            sortOrder
        };
        
        const devices = await serverBackend.getAllDevices(filters);
        
        res.json({
            success: true,
            data: {
                devices,
                total: devices.length
            }
        });
    } catch (err) {
        console.error('Get devices error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * GET /api/devices/:id - Get single device with sysinfo and latest metrics
 */
router.get('/api/devices/:id', requireAuth, async (req, res) => {
    try {
        const device = await serverBackend.getDeviceById(req.params.id);
        
        if (!device) {
            return res.status(404).json({
                success: false,
                error: req.t('devices.not_found')
            });
        }

        // Enrich with sysinfo data (from peer_sysinfo table)
        try {
            const sysinfo = await db.getPeerSysinfo(req.params.id);
            if (sysinfo) {
                device.sysinfo = sysinfo;
            }
        } catch (e) {
            // sysinfo table may not exist yet — silently skip
        }

        // Enrich with latest heartbeat metrics
        try {
            const latestMetric = await db.getLatestPeerMetric(req.params.id);
            if (latestMetric) {
                device.metrics = {
                    cpu_usage: latestMetric.cpu_usage,
                    memory_usage: latestMetric.memory_usage,
                    disk_usage: latestMetric.disk_usage,
                    updated_at: latestMetric.created_at
                };
            }
        } catch (e) {
            // metrics table may not exist yet — silently skip
        }

        // Enrich with recent metrics history (last 20 data-points for charts)
        try {
            const metricsHistory = await db.getPeerMetrics(req.params.id, 20);
            if (metricsHistory && metricsHistory.length > 0) {
                device.metrics_history = metricsHistory.map(m => ({
                    cpu: m.cpu_usage,
                    memory: m.memory_usage,
                    disk: m.disk_usage,
                    time: m.created_at
                }));
            }
        } catch (e) {
            // silently skip
        }

        // Enrich with device group memberships
        try {
            const groups = await db.getDeviceGroupsForPeer(req.params.id);
            if (groups && groups.length > 0) {
                device.groups = groups;
            }
        } catch (e) {
            // silently skip
        }

        res.json({
            success: true,
            data: device
        });
    } catch (err) {
        console.error('Get device error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * PATCH /api/devices/:id - Update device (name, note)
 */
router.patch('/api/devices/:id', requireAuth, requireRole('operator'), async (req, res) => {
    try {
        const { user, note } = req.body;
        const id = req.params.id;
        
        // Check device exists
        const device = await serverBackend.getDeviceById(id);
        if (!device) {
            return res.status(404).json({
                success: false,
                error: req.t('devices.not_found')
            });
        }
        
        const result = await serverBackend.updateDevice(id, { user, note });
        
        // Log action
        await db.logAction(req.session.userId, 'device_updated', `Device ${id} updated`, req.ip);
        
        res.json({
            success: true,
            data: { changes: result.changes }
        });
    } catch (err) {
        console.error('Update device error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * DELETE /api/devices/:id - Delete device (soft delete)
 */
router.delete('/api/devices/:id', requireAuth, requireRole('operator'), async (req, res) => {
    try {
        const id = req.params.id;
        
        const device = await serverBackend.getDeviceById(id);
        if (!device) {
            return res.status(404).json({
                success: false,
                error: req.t('devices.not_found')
            });
        }
        
        const result = await serverBackend.deleteDevice(id);
        
        if (!result || !result.success) {
            return res.status(500).json({
                success: false,
                error: result?.error || req.t('devices.delete_failed')
            });
        }
        
        // Clean up local auth.db data for this peer
        try {
            await db.cleanupDeletedPeerData(id);
        } catch { /* non-critical: auth.db cleanup is secondary */ }
        
        // Log action
        await db.logAction(req.session.userId, 'device_deleted', `Device ${id} deleted`, req.ip);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Delete device error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * POST /api/devices/:id/ban - Ban device
 */
router.post('/api/devices/:id/ban', requireAuth, requireRole('operator'), async (req, res) => {
    try {
        const id = req.params.id;
        const { reason } = req.body;
        
        const device = await serverBackend.getDeviceById(id);
        if (!device) {
            return res.status(404).json({
                success: false,
                error: req.t('devices.not_found')
            });
        }
        
        await serverBackend.setBanStatus(id, true, reason || '');
        
        // Log action
        await db.logAction(req.session.userId, 'device_banned', `Device ${id} banned: ${reason}`, req.ip);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Ban device error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * POST /api/devices/:id/unban - Unban device
 */
router.post('/api/devices/:id/unban', requireAuth, requireRole('operator'), async (req, res) => {
    try {
        const id = req.params.id;
        
        const device = await serverBackend.getDeviceById(id);
        if (!device) {
            return res.status(404).json({
                success: false,
                error: req.t('devices.not_found')
            });
        }
        
        await serverBackend.setBanStatus(id, false);
        
        // Log action
        await db.logAction(req.session.userId, 'device_unbanned', `Device ${id} unbanned`, req.ip);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Unban device error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * POST /api/devices/:id/change-id - Change device ID
 */
router.post('/api/devices/:id/change-id', requireAuth, requireRole('operator'), async (req, res) => {
    try {
        const oldId = req.params.id;
        const { newId } = req.body;
        
        if (!newId || newId.length < 6 || newId.length > 16) {
            return res.status(400).json({
                success: false,
                error: req.t('devices.invalid_id')
            });
        }
        
        // Validate format (alphanumeric + dash + underscore)
        if (!/^[A-Za-z0-9_-]+$/.test(newId)) {
            return res.status(400).json({
                success: false,
                error: req.t('devices.invalid_id_format')
            });
        }
        
        // Check if new ID already exists
        const existing = await serverBackend.getDeviceById(newId);
        if (existing) {
            return res.status(400).json({
                success: false,
                error: req.t('devices.id_exists')
            });
        }
        
        // Try to change via server backend API
        const result = await serverBackend.changePeerId(oldId, newId);
        
        if (!result || !result.success) {
            return res.status(400).json({
                success: false,
                error: result?.error || req.t('devices.change_id_failed')
            });
        }
        
        // Log action
        await db.logAction(req.session.userId, 'device_id_changed', `Device ID changed from ${oldId} to ${newId}`, req.ip);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Change ID error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * PUT /api/devices/:id/tags - Set device tags
 */
router.put('/api/devices/:id/tags', requireAuth, requireRole('operator'), async (req, res) => {
    try {
        const id = req.params.id;
        const { tags } = req.body;

        if (!Array.isArray(tags)) {
            return res.status(400).json({
                success: false,
                error: 'Tags must be an array'
            });
        }

        // Validate tag values: non-empty strings, max 50 chars each, max 20 tags
        const cleaned = tags
            .filter(t => typeof t === 'string' && t.trim().length > 0)
            .map(t => t.trim().slice(0, 50));

        if (cleaned.length > 20) {
            return res.status(400).json({
                success: false,
                error: 'Maximum 20 tags allowed'
            });
        }

        const device = await serverBackend.getDeviceById(id);
        if (!device) {
            return res.status(404).json({
                success: false,
                error: req.t('devices.not_found')
            });
        }

        // BetterDesk backend: delegate to Go server
        if (serverBackend.isBetterDesk()) {
            const result = await serverBackend.setPeerTags(id, cleaned);
            if (!result || !result.success) {
                return res.status(400).json({
                    success: false,
                    error: result?.error || 'Failed to set tags'
                });
            }
        }
        // Note: in rustdesk mode, tags are not supported (no-op)

        // Log action
        await db.logAction(req.session.userId, 'device_tags_updated', `Device ${id} tags set to [${cleaned.join(', ')}]`, req.ip);

        res.json({
            success: true,
            data: { tags: cleaned }
        });
    } catch (err) {
        console.error('Set tags error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * POST /api/devices/bulk-delete - Delete multiple devices
 */
router.post('/api/devices/bulk-delete', requireAuth, requireRole('operator'), async (req, res) => {
    try {
        const { ids } = req.body;
        
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({
                success: false,
                error: req.t('devices.no_selection')
            });
        }
        
        let deleted = 0;
        for (const id of ids) {
            const result = await serverBackend.deleteDevice(id);
            // In betterdesk mode, result is {success, data}; in rustdesk, result has .changes
            if (result && (result.success || result.changes)) deleted++;
        }
        
        // Log action
        await db.logAction(req.session.userId, 'devices_bulk_deleted', `${deleted} devices deleted`, req.ip);
        
        res.json({
            success: true,
            data: { deleted }
        });
    } catch (err) {
        console.error('Bulk delete error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

module.exports = router;
