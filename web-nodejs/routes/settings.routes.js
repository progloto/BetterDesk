/**
 * BetterDesk Console - Settings Routes
 */

const express = require('express');
const router = express.Router();
const config = require('../config/config');
const keyService = require('../services/keyService');
const db = require('../services/database');
const brandingService = require('../services/brandingService');
const serverBackend = require('../services/serverBackend');
const backupService = require('../services/backupService');
const updateService = require('../services/updateService');
const { requireAuth, requirePermission } = require('../middleware/auth');
const os = require('os');
const multer = require('multer');

/**
 * GET /settings - Settings page
 */
router.get('/settings', requireAuth, (req, res) => {
    res.render('settings', {
        title: req.t('nav.settings'),
        activePage: 'settings'
    });
});

/**
 * GET /api/settings/info - Get server configuration info
 */
router.get('/api/settings/info', requireAuth, async (req, res) => {
    try {
        const serverHealth = await serverBackend.getHealth();
        const serverConfig = keyService.getServerConfig();
        const stats = await db.getStats();
        
        res.json({
            success: true,
            data: {
                app: {
                    name: config.appName,
                    version: config.appVersion,
                    nodeVersion: process.version,
                    env: config.nodeEnv
                },
                server: {
                    hostname: os.hostname(),
                    platform: os.platform(),
                    arch: os.arch(),
                    uptime: Math.floor(process.uptime()),
                    memoryUsage: process.memoryUsage().heapUsed
                },
                goServer: serverHealth,
                backend: serverBackend.getActiveBackend(),
                paths: {
                    database: config.dbPath,
                    publicKey: config.pubKeyPath,
                    apiKey: config.apiKeyPath
                },
                stats: stats
            }
        });
    } catch (err) {
        console.error('Get server info error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * GET /api/settings/server-info - Alias for /api/keys/server-info (backward compatibility)
 */
router.get('/api/settings/server-info', requireAuth, (req, res) => {
    try {
        const apiKey = keyService.getApiKey(true);
        
        let serverIp = req.headers['x-forwarded-host'] || req.headers.host || req.hostname || '-';
        serverIp = serverIp.split(':')[0];
        
        res.json({
            success: true,
            data: {
                server_id: serverIp,
                relay_server: serverIp,
                api_key_masked: apiKey || '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'
            }
        });
    } catch (err) {
        console.error('Get server info error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * GET /api/settings/audit - Get audit log
 */
router.get('/api/settings/audit', requireAuth, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit, 10) || 100;
        const logs = await db.getAuditLogs(limit);
        
        res.json({
            success: true,
            data: logs
        });
    } catch (err) {
        console.error('Get audit logs error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

// ==================== Branding / Theming API ====================

/**
 * GET /api/settings/branding - Get current branding configuration
 */
router.get('/api/settings/branding', requireAuth, (req, res) => {
    try {
        const branding = brandingService.getBranding();
        res.json({ success: true, data: branding });
    } catch (err) {
        console.error('Get branding error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * POST /api/settings/branding - Save branding configuration (admin only)
 */
router.post('/api/settings/branding', requireAuth, requirePermission('branding.edit'), async (req, res) => {
    try {
        const updates = req.body;
        if (!updates || typeof updates !== 'object') {
            return res.status(400).json({ success: false, error: 'Invalid branding data' });
        }
        
        await brandingService.saveBranding(updates);
        
        await db.logAction(req.session?.userId, 'branding_update', 'Updated branding configuration', req.ip);
        
        res.json({ success: true, message: 'Branding saved' });
    } catch (err) {
        console.error('Save branding error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * POST /api/settings/branding/reset - Reset branding to defaults (admin only)
 */
router.post('/api/settings/branding/reset', requireAuth, requirePermission('branding.edit'), async (req, res) => {
    try {
        await brandingService.resetBranding();
        
        await db.logAction(req.session?.userId, 'branding_reset', 'Reset branding to defaults', req.ip);
        
        res.json({ success: true, message: 'Branding reset to defaults' });
    } catch (err) {
        console.error('Reset branding error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * GET /api/settings/branding/export - Export branding preset as JSON
 */
router.get('/api/settings/branding/export', requireAuth, requirePermission('branding.edit'), (req, res) => {
    try {
        const preset = brandingService.exportPreset();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename="betterdesk-theme.json"');
        res.json(preset);
    } catch (err) {
        console.error('Export branding error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * POST /api/settings/branding/import - Import branding preset from JSON (admin only)
 */
router.post('/api/settings/branding/import', requireAuth, requirePermission('branding.edit'), async (req, res) => {
    try {
        const preset = req.body;
        const success = await brandingService.importPreset(preset);
        
        if (!success) {
            return res.status(400).json({ success: false, error: 'Invalid theme preset file' });
        }
        
        await db.logAction(req.session?.userId, 'branding_import', 'Imported branding preset', req.ip);
        
        res.json({ success: true, message: 'Theme imported successfully' });
    } catch (err) {
        console.error('Import branding error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * GET /api/settings/themes - List available theme presets
 */
router.get('/api/settings/themes', requireAuth, (req, res) => {
    try {
        const fs = require('fs');
        const path = require('path');
        const themesDir = path.join(__dirname, '..', 'themes');
        const themes = [];

        if (fs.existsSync(themesDir)) {
            for (const file of fs.readdirSync(themesDir)) {
                if (!file.endsWith('.json')) continue;
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(themesDir, file), 'utf8'));
                    if (data.type === 'betterdesk-theme' && data.branding) {
                        themes.push({
                            id: file.replace('.json', ''),
                            name: data.branding.appName || file.replace('.json', ''),
                            description: data.branding.appDescription || '',
                            colors: data.branding.colors || {}
                        });
                    }
                } catch { /* skip invalid files */ }
            }
        }

        res.json({ success: true, data: themes });
    } catch (err) {
        console.error('List themes error:', err);
        res.status(500).json({ success: false, error: 'Failed to list themes' });
    }
});

/**
 * POST /api/settings/themes/:id/apply - Apply a built-in theme preset (admin only)
 */
router.post('/api/settings/themes/:id/apply', requireAuth, requirePermission('branding.edit'), async (req, res) => {
    try {
        const fs = require('fs');
        const path = require('path');
        const themeFile = path.join(__dirname, '..', 'themes', req.params.id + '.json');

        if (!fs.existsSync(themeFile)) {
            return res.status(404).json({ success: false, error: 'Theme not found' });
        }

        const preset = JSON.parse(fs.readFileSync(themeFile, 'utf8'));
        const success = await brandingService.importPreset(preset);

        if (!success) {
            return res.status(400).json({ success: false, error: 'Invalid theme format' });
        }

        const db = require('../services/database');
        await db.logAction(req.session?.userId, 'theme_apply', `Applied theme: ${req.params.id}`, req.ip);

        res.json({ success: true, message: `Theme "${req.params.id}" applied` });
    } catch (err) {
        console.error('Apply theme error:', err);
        res.status(500).json({ success: false, error: 'Failed to apply theme' });
    }
});

/**
 * GET /css/theme.css - Dynamic CSS theme overrides (no auth required, cached)
 */
router.get('/css/theme.css', (req, res) => {
    try {
        const css = brandingService.generateThemeCss();
        res.setHeader('Content-Type', 'text/css');
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.send(css);
    } catch (err) {
        res.setHeader('Content-Type', 'text/css');
        res.send('/* theme error */');
    }
});

/**
 * GET /branding/favicon.svg - Dynamic favicon from branding (no auth required)
 */
router.get('/branding/favicon.svg', (req, res) => {
    try {
        const svg = brandingService.generateFavicon();
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.send(svg);
    } catch (err) {
        res.status(500).send('');
    }
});

// ==================== Backup & Restore API ====================

// multer configured for in-memory buffer (max 10 MB)
const backupUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
});

/**
 * GET /api/settings/backup/stats - Preview backup size/contents
 */
router.get('/api/settings/backup/stats', requireAuth, requirePermission('server.config'), (req, res) => {
    try {
        const stats = backupService.getBackupStats();
        res.json({ success: true, data: stats });
    } catch (err) {
        console.error('Backup stats error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * GET /api/settings/backup - Download full backup as JSON file
 */
router.get('/api/settings/backup', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const backup = await backupService.createBackup();
        const json = JSON.stringify(backup, null, 2);
        const filename = `betterdesk-backup-${new Date().toISOString().slice(0, 10)}.json`;

        await db.logAction(req.session?.userId, 'backup_created', `Backup downloaded (${(json.length / 1024).toFixed(1)} KB)`, req.ip);

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(json);
    } catch (err) {
        console.error('Backup download error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * POST /api/settings/restore - Upload and restore from backup JSON
 * Expects multipart/form-data with field "backup" (JSON file)
 * Optional JSON body fields: restoreSettings, restoreBranding, restoreUsers, etc.
 */
router.post('/api/settings/restore', requireAuth, requirePermission('server.config'), backupUpload.single('backup'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: req.t('backup.no_file') });
        }

        // Parse JSON from uploaded file buffer
        let data;
        try {
            data = JSON.parse(req.file.buffer.toString('utf-8'));
        } catch {
            return res.status(400).json({ success: false, error: req.t('backup.invalid_json') });
        }

        // Validate
        const validation = backupService.validateBackup(data);
        if (!validation.valid) {
            return res.status(400).json({ success: false, error: validation.errors.join('; ') });
        }

        // Parse restore options from query params or body
        const opts = {
            restoreSettings: req.body.restoreSettings !== 'false',
            restoreBranding: req.body.restoreBranding !== 'false',
            restoreUsers: req.body.restoreUsers === 'true',      // Off by default — destructive
            restoreFolders: req.body.restoreFolders !== 'false',
            restoreGroups: req.body.restoreGroups !== 'false',
            restoreAddressBooks: req.body.restoreAddressBooks !== 'false'
        };

        const result = backupService.restoreBackup(data, opts);

        await db.logAction(
            req.session?.userId, 'backup_restored',
            `Restored: ${result.restored.join(', ')} | Skipped: ${result.skipped.join(', ')}`,
            req.ip
        );

        res.json({
            success: true,
            data: {
                restored: result.restored,
                skipped: result.skipped,
                warnings: result.warnings,
                backupDate: data._created,
                backupVersion: data._console_version
            }
        });
    } catch (err) {
        console.error('Restore error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

// ==================== Self-Update API ====================

/**
 * GET /api/settings/updates/check - Check for available updates
 */
router.get('/api/settings/updates/check', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const result = await updateService.checkForUpdates();
        res.json({ success: true, data: result });
    } catch (err) {
        console.error('Update check error:', err);
        res.status(500).json({ success: false, error: 'Failed to check for updates: ' + err.message });
    }
});

/**
 * GET /api/settings/updates/changes - Get list of changed files between local SHA and remote
 */
router.get('/api/settings/updates/changes', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const { sha } = req.query;
        if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) {
            return res.status(400).json({ success: false, error: 'Valid SHA parameter required' });
        }
        const result = await updateService.getChangedFiles(sha);
        res.json({ success: true, data: result });
    } catch (err) {
        console.error('Get changes error:', err);
        res.status(500).json({ success: false, error: 'Failed to get changed files: ' + err.message });
    }
});

/**
 * POST /api/settings/updates/install - Apply the update
 * Body: { remoteSHA, createBackup: true/false, components: ['console','scripts'] }
 */
router.post('/api/settings/updates/install', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const { remoteSHA, createBackup, components } = req.body;
        if (!remoteSHA || !/^[0-9a-f]{7,40}$/i.test(remoteSHA)) {
            return res.status(400).json({ success: false, error: 'Valid remoteSHA is required' });
        }

        // Get changed files
        const changedData = await updateService.getChangedFiles(remoteSHA);
        if (changedData.totalFiles === 0) {
            return res.json({ success: true, data: { applied: [], message: 'No files to update' } });
        }

        // Apply update
        const result = await updateService.applyUpdate(remoteSHA, changedData, {
            createBackup: createBackup !== false,
            components: components || ['console', 'scripts']
        });

        await db.logAction(
            req.session?.userId,
            'system_update',
            `Updated to ${remoteSHA.slice(0, 7)} (${result.applied.length} applied, ${result.failed.length} failed)`,
            req.ip
        );

        // Restart Go server if changes detected and component selected
        if (result.needsServerRestart && (components || []).includes('server')) {
            const svc = updateService.restartService(
                process.platform === 'win32' ? 'BetterDeskServer' : 'betterdesk-server'
            );
            if (svc.success) result.servicesRestarted.push('server');
            else result.servicesFailed.push({ service: 'server', error: svc.error });
        }

        res.json({ success: true, data: result });

        // Restart console after response is sent (systemd/NSSM restarts automatically)
        if (result.needsConsoleRestart) {
            setTimeout(() => {
                console.log(`[UPDATE] Restarting console after update to ${remoteSHA.slice(0, 7)}...`);
                process.exit(0);
            }, 2000);
        }
    } catch (err) {
        console.error('Update install error:', err);
        res.status(500).json({ success: false, error: 'Update failed: ' + err.message });
    }
});

/**
 * GET /api/settings/updates/backups - List pre-update backups
 */
router.get('/api/settings/updates/backups', requireAuth, requirePermission('server.config'), (req, res) => {
    try {
        const backups = updateService.listBackups();
        res.json({ success: true, data: backups });
    } catch (err) {
        console.error('List backups error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * POST /api/settings/updates/restore - Restore from pre-update backup
 * Body: { backupName }
 */
router.post('/api/settings/updates/restore', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const { backupName } = req.body;
        if (!backupName || typeof backupName !== 'string') {
            return res.status(400).json({ success: false, error: 'backupName is required' });
        }

        const result = updateService.restoreFromBackup(backupName);

        await db.logAction(
            req.session?.userId,
            'system_restore',
            `Restored from backup: ${backupName} (v${result.version}, ${result.restored} files)`,
            req.ip
        );

        res.json({ success: true, data: result });

        // Restart after restore
        setTimeout(() => {
            console.log(`[UPDATE] Restarting after restore from ${backupName}...`);
            process.exit(0);
        }, 2000);
    } catch (err) {
        console.error('Restore error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
