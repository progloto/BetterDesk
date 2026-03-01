/**
 * BetterDesk Console - Routes Index
 * Mounts all route modules
 */

const express = require('express');
const router = express.Router();

const authRoutes = require('./auth.routes');
const dashboardRoutes = require('./dashboard.routes');
const devicesRoutes = require('./devices.routes');
const keysRoutes = require('./keys.routes');
const settingsRoutes = require('./settings.routes');
const generatorRoutes = require('./generator.routes');
const i18nRoutes = require('./i18n.routes');
const usersRoutes = require('./users.routes');
const foldersRoutes = require('./folders.routes');
const remoteRoutes = require('./remote.routes');
const bdApiRoutes = require('./bd-api.routes');
const inventoryRoutes = require('./inventory.routes');
const ticketsRoutes = require('./tickets.routes');
const activityRoutes = require('./activity.routes');
const automationRoutes = require('./automation.routes');
const fileTransferRoutes = require('./fileTransfer.routes');
const networkRoutes = require('./network.routes');
const dataguardRoutes = require('./dataguard.routes');
const reportsRoutes = require('./reports.routes');
const tenantsRoutes = require('./tenants.routes');
const registrationRoutes = require('./registration.routes');

/**
 * Middleware to require JSON Content-Type for POST/PATCH/PUT requests to API routes.
 * This provides an additional layer of CSRF protection.
 */
function requireJsonContentType(req, res, next) {
    // Skip for GET, DELETE, OPTIONS, HEAD
    if (['GET', 'DELETE', 'OPTIONS', 'HEAD'].includes(req.method)) {
        return next();
    }
    // Skip for non-API routes (form submissions, file uploads)
    if (!req.path.startsWith('/api/')) {
        return next();
    }
    // Skip for specific routes that accept form data (file uploads)
    if (req.path.includes('/upload') || req.path.includes('/import')) {
        return next();
    }
    // Check Content-Type
    if (!req.is('application/json')) {
        return res.status(415).json({ 
            success: false, 
            error: 'Content-Type must be application/json' 
        });
    }
    next();
}

// Apply JSON content type check middleware
router.use(requireJsonContentType);

// Health check (no auth required)
router.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Mount routes
router.use('/', authRoutes);
router.use('/', dashboardRoutes);
router.use('/', devicesRoutes);
router.use('/', keysRoutes);
router.use('/', settingsRoutes);
router.use('/', generatorRoutes);
router.use('/', usersRoutes);
router.use('/', foldersRoutes);
router.use('/', remoteRoutes);
router.use('/api/i18n', i18nRoutes);
router.use('/api/bd', bdApiRoutes);
router.use('/api/bd', inventoryRoutes);     // device-facing: /api/bd/inventory, /api/bd/telemetry
router.use('/api/inventory', inventoryRoutes); // admin-facing: /api/inventory, /api/inventory/:id
router.use('/api/tickets', ticketsRoutes);      // admin-facing: /api/tickets CRUD
router.use('/api/tickets', ticketsRoutes);      // device-facing: /api/tickets/bd (agent creates tickets)
router.use('/api/bd', activityRoutes);           // device-facing: /api/bd/activity
router.use('/api/activity', activityRoutes);     // admin-facing: /api/activity
router.use('/api/automation', automationRoutes); // admin-facing: /api/automation/*
router.use('/api/bd', automationRoutes);         // device-facing: /api/bd/commands
router.use('/api/files', fileTransferRoutes);    // admin-facing: /api/files/transfer(s)
router.use('/api/bd', fileTransferRoutes);       // device-facing: /api/bd/file-transfer
router.use('/api/network', networkRoutes);       // admin-facing: /api/network/*
router.use('/api/dataguard', dataguardRoutes);   // admin-facing: /api/dataguard/*
router.use('/api/bd', dataguardRoutes);          // device-facing: /api/bd/dlp-policies, /api/bd/dlp-events
router.use('/api/reports', reportsRoutes);       // admin-facing: /api/reports/*
router.use('/api/tenants', tenantsRoutes);       // admin-facing: /api/tenants/*
router.use('/', registrationRoutes);               // admin-facing: /registrations, /api/registrations/*
router.use('/api/bd', registrationRoutes);          // device-facing: /api/bd/register-request, /api/bd/register-status

module.exports = router;
