/**
 * BetterDesk Console - Users Routes
 * User management for admins (CRUD operations)
 */

const express = require('express');
const router = express.Router();
const authService = require('../services/authService');
const db = require('../services/database');
const { requireAuth, requirePermission, isSuperAdminRole } = require('../middleware/auth');
const { passwordChangeLimiter } = require('../middleware/rateLimiter');

/**
 * GET /users - Users management page (admin only)
 */
router.get('/users', requireAuth, requirePermission('user.view'), (req, res) => {
    res.render('users', {
        title: req.t('nav.users'),
        activePage: 'users'
    });
});

/**
 * GET /api/users - Get all users (admin only)
 */
router.get('/api/users', requireAuth, requirePermission('user.view'), async (req, res) => {
    try {
        const users = await db.getAllUsers();
        
        // Remove sensitive data
        const safeUsers = users.map(u => ({
            id: u.id,
            username: u.username,
            role: u.role,
            created_at: u.created_at,
            last_login: u.last_login
        }));
        
        res.json({
            success: true,
            data: {
                users: safeUsers,
                total: safeUsers.length
            }
        });
    } catch (err) {
        console.error('Get users error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * POST /api/users - Create new user (admin only)
 */
router.post('/api/users', requireAuth, requirePermission('user.create'), passwordChangeLimiter, async (req, res) => {
    try {
        const { username, password, role } = req.body;
        
        // Validate input
        if (!username || !password) {
            return res.status(400).json({
                success: false,
                error: req.t('users.fill_required')
            });
        }
        
        // Validate username format
        if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
            return res.status(400).json({
                success: false,
                error: req.t('users.invalid_username')
            });
        }
        
        // Check username uniqueness
        const existingUser = await db.getUserByUsername(username);
        if (existingUser) {
            return res.status(400).json({
                success: false,
                error: req.t('users.username_exists')
            });
        }
        
        // Validate password strength
        const passwordCheck = authService.validatePasswordStrength(password);
        if (passwordCheck.strength === 'weak') {
            return res.status(400).json({
                success: false,
                error: req.t('users.weak_password'),
                feedback: passwordCheck.feedback
            });
        }
        
        // Validate role (7-role hierarchy — Phase 52)
        const validRoles = ['super_admin', 'admin', 'server_admin', 'global_admin', 'operator', 'viewer', 'pro'];
        const userRole = validRoles.includes(role) ? role : 'viewer';
        
        // Hash password
        const passwordHash = await authService.hashPassword(password);
        
        // Create user
        const result = await db.createUser(username, passwordHash, userRole);
        
        // Log action
        await db.logAction(req.session.userId, 'user_created', `Created user: ${username} (${userRole})`, req.ip);
        
        res.json({
            success: true,
            data: {
                id: result.id,
                username,
                role: userRole
            }
        });
    } catch (err) {
        console.error('Create user error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * PATCH /api/users/:id - Update user (admin only)
 */
router.patch('/api/users/:id', requireAuth, requirePermission('user.edit'), async (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId) || userId <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        const { role, password } = req.body;
        
        const user = await db.getUserById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                error: req.t('users.not_found')
            });
        }
        
        // Prevent self-demotion from admin-level role
        if (userId === req.session.userId && role && isSuperAdminRole(req.session.user.role) && !isSuperAdminRole(role)) {
            return res.status(400).json({
                success: false,
                error: req.t('users.cannot_demote_self')
            });
        }
        
        // Update role if provided
        if (role) {
            const validRoles = ['super_admin', 'admin', 'server_admin', 'global_admin', 'operator', 'viewer', 'pro'];
            if (!validRoles.includes(role)) {
                return res.status(400).json({
                    success: false,
                    error: req.t('users.invalid_role')
                });
            }
            await db.updateUserRole(userId, role);
        }
        
        // Update password if provided
        if (password) {
            const passwordCheck = authService.validatePasswordStrength(password);
            if (passwordCheck.strength === 'weak') {
                return res.status(400).json({
                    success: false,
                    error: req.t('users.weak_password'),
                    feedback: passwordCheck.feedback
                });
            }
            
            const passwordHash = await authService.hashPassword(password);
            await db.updateUserPassword(userId, passwordHash);
        }
        
        // Log action
        await db.logAction(req.session.userId, 'user_updated', `Updated user: ${user.username}`, req.ip);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Update user error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * DELETE /api/users/:id - Delete user (admin only)
 */
router.delete('/api/users/:id', requireAuth, requirePermission('user.delete'), async (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId) || userId <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        
        const user = await db.getUserById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                error: req.t('users.not_found')
            });
        }
        
        // Prevent self-deletion
        if (userId === req.session.userId) {
            return res.status(400).json({
                success: false,
                error: req.t('users.cannot_delete_self')
            });
        }
        
        // Ensure at least one admin remains
        const adminCount = await db.countAdmins();
        if (isSuperAdminRole(user.role) && adminCount <= 1) {
            return res.status(400).json({
                success: false,
                error: req.t('users.last_admin')
            });
        }
        
        await db.deleteUser(userId);
        
        // Log action
        await db.logAction(req.session.userId, 'user_deleted', `Deleted user: ${user.username}`, req.ip);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Delete user error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * POST /api/users/:id/reset-password - Admin reset user password
 */
router.post('/api/users/:id/reset-password', requireAuth, requirePermission('user.edit'), passwordChangeLimiter, async (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId) || userId <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        const { newPassword } = req.body;
        
        const user = await db.getUserById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                error: req.t('users.not_found')
            });
        }
        
        if (!newPassword) {
            return res.status(400).json({
                success: false,
                error: req.t('users.password_required')
            });
        }
        
        const passwordCheck = authService.validatePasswordStrength(newPassword);
        if (passwordCheck.strength === 'weak') {
            return res.status(400).json({
                success: false,
                error: req.t('users.weak_password'),
                feedback: passwordCheck.feedback
            });
        }
        
        const passwordHash = await authService.hashPassword(newPassword);
        await db.updateUserPassword(userId, passwordHash);
        
        // Log action
        await db.logAction(req.session.userId, 'password_reset', `Reset password for user: ${user.username}`, req.ip);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Reset password error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

module.exports = router;
