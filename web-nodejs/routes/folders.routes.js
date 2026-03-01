/**
 * BetterDesk Console - Folders Routes
 * Device folder organization
 */

const express = require('express');
const router = express.Router();
const db = require('../services/database');
const serverBackend = require('../services/serverBackend');
const { requireAuth } = require('../middleware/auth');

/**
 * GET /api/folders - Get all folders
 */
router.get('/api/folders', requireAuth, (req, res) => {
    try {
        const folders = db.getAllFolders();
        
        res.json({
            success: true,
            data: {
                folders,
                total: folders.length
            }
        });
    } catch (err) {
        console.error('Get folders error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * POST /api/folders - Create new folder
 */
router.post('/api/folders', requireAuth, (req, res) => {
    try {
        const { name, color, icon } = req.body;
        
        if (!name || name.trim().length === 0) {
            return res.status(400).json({
                success: false,
                error: req.t('folders.name_required')
            });
        }
        
        if (name.length > 50) {
            return res.status(400).json({
                success: false,
                error: req.t('folders.name_too_long')
            });
        }
        
        const result = db.createFolder(name.trim(), color || '#6366f1', icon || 'folder');
        
        // Log action
        db.logAction(req.session.userId, 'folder_created', `Created folder: ${name}`, req.ip);
        
        res.json({
            success: true,
            data: {
                id: result.lastInsertRowid,
                name: name.trim(),
                color: color || '#6366f1',
                icon: icon || 'folder'
            }
        });
    } catch (err) {
        console.error('Create folder error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * PATCH /api/folders/:id - Update folder
 */
router.patch('/api/folders/:id', requireAuth, (req, res) => {
    try {
        const folderId = parseInt(req.params.id, 10);
        const { name, color, icon } = req.body;
        
        const folder = db.getFolderById(folderId);
        if (!folder) {
            return res.status(404).json({
                success: false,
                error: req.t('folders.not_found')
            });
        }
        
        if (name !== undefined) {
            if (name.trim().length === 0) {
                return res.status(400).json({
                    success: false,
                    error: req.t('folders.name_required')
                });
            }
            if (name.length > 50) {
                return res.status(400).json({
                    success: false,
                    error: req.t('folders.name_too_long')
                });
            }
        }
        
        db.updateFolder(folderId, {
            name: name !== undefined ? name.trim() : undefined,
            color,
            icon
        });
        
        // Log action
        db.logAction(req.session.userId, 'folder_updated', `Updated folder: ${name || folder.name}`, req.ip);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Update folder error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * DELETE /api/folders/:id - Delete folder
 */
router.delete('/api/folders/:id', requireAuth, (req, res) => {
    try {
        const folderId = parseInt(req.params.id, 10);
        
        const folder = db.getFolderById(folderId);
        if (!folder) {
            return res.status(404).json({
                success: false,
                error: req.t('folders.not_found')
            });
        }
        
        // Remove folder assignment from devices
        db.unassignDevicesFromFolder(folderId);
        
        // Delete folder
        db.deleteFolder(folderId);
        
        // Log action
        db.logAction(req.session.userId, 'folder_deleted', `Deleted folder: ${folder.name}`, req.ip);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Delete folder error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * POST /api/folders/:id/devices - Assign devices to folder
 */
router.post('/api/folders/:id/devices', requireAuth, (req, res) => {
    try {
        const folderId = parseInt(req.params.id, 10);
        const { deviceIds } = req.body;
        
        if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
            return res.status(400).json({
                success: false,
                error: req.t('folders.no_devices_selected')
            });
        }
        
        // Verify folder exists (null = unassign)
        if (folderId !== 0) {
            const folder = db.getFolderById(folderId);
            if (!folder) {
                return res.status(404).json({
                    success: false,
                    error: req.t('folders.not_found')
                });
            }
        }
        
        const assignFolderId = folderId === 0 ? null : folderId;
        
        db.assignDevicesToFolder(deviceIds, assignFolderId);
        
        // Log action
        db.logAction(req.session.userId, 'devices_moved', 
            `Moved ${deviceIds.length} device(s) to folder ID: ${folderId}`, req.ip);
        
        res.json({
            success: true,
            data: { count: deviceIds.length }
        });
    } catch (err) {
        console.error('Assign devices error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * PATCH /api/devices/:id/folder - Assign single device to folder
 */
router.patch('/api/devices/:id/folder', requireAuth, async (req, res) => {
    try {
        const deviceId = req.params.id;
        const { folderId } = req.body;
        
        // Use serverBackend to verify device exists (works in both modes)
        const device = await serverBackend.getDeviceById(deviceId);
        if (!device) {
            return res.status(404).json({
                success: false,
                error: req.t('devices.not_found')
            });
        }
        
        // Verify folder exists (null to unassign)
        if (folderId !== null && folderId !== undefined) {
            const folder = db.getFolderById(folderId);
            if (!folder) {
                return res.status(404).json({
                    success: false,
                    error: req.t('folders.not_found')
                });
            }
        }
        
        db.assignDeviceToFolder(deviceId, folderId);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Assign device folder error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

module.exports = router;
