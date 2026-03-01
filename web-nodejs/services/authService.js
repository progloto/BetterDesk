/**
 * BetterDesk Console - Auth Service
 * Handles user authentication, password hashing, session management
 */

const bcrypt = require('bcrypt');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const crypto = require('crypto');
const db = require('./database');
const config = require('../config/config');

const SALT_ROUNDS = 12;

// Pre-computed dummy hash for timing-safe comparison (prevents user enumeration)
const DUMMY_HASH = '$2b$12$KiXeOj5vHpJRJHGMhWzadeKfRJLvJRaRHQbMGBBdkpu.jQfXAzgWS';

/**
 * Hash a password using bcrypt
 */
async function hashPassword(password) {
    return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verify password against hash
 */
async function verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
}

/**
 * Authenticate user with username and password
 * Returns user object with totpRequired flag if 2FA is enabled
 */
async function authenticate(username, password) {
    const user = db.getUserByUsername(username);
    
    if (!user) {
        // Timing-safe: do a real hash comparison to prevent user enumeration
        await bcrypt.compare(password, DUMMY_HASH);
        return null;
    }
    
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
        return null;
    }
    
    // Check if TOTP is enabled
    if (user.totp_enabled) {
        return {
            id: user.id,
            username: user.username,
            role: user.role,
            totpRequired: true
        };
    }
    
    // Update last login
    db.updateLastLogin(user.id);
    
    return {
        id: user.id,
        username: user.username,
        role: user.role,
        totpRequired: false
    };
}

/**
 * Create default admin user if no users exist
 */
async function ensureDefaultAdmin() {
    if (db.hasUsers()) {
        return false;
    }
    
    const defaultUsername = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
    const defaultPassword = process.env.DEFAULT_ADMIN_PASSWORD || require('crypto').randomBytes(16).toString('hex');
    
    const hash = await hashPassword(defaultPassword);
    db.createUser(defaultUsername, hash, 'admin');
    
    console.log(`Created default admin user: ${defaultUsername}`);
    if (!process.env.DEFAULT_ADMIN_PASSWORD) {
        console.log(`Generated admin password: ${defaultPassword}`);
    }
    console.log('IMPORTANT: Change the default password immediately!');
    
    return true;
}

/**
 * Change user password
 */
async function changePassword(userId, currentPassword, newPassword) {
    const user = db.getUserById(userId);
    if (!user) {
        return { success: false, error: 'User not found' };
    }
    
    const valid = await verifyPassword(currentPassword, user.password_hash);
    if (!valid) {
        return { success: false, error: 'Current password is incorrect' };
    }
    
    // Validate new password strength
    if (newPassword.length < 8) {
        return { success: false, error: 'Password must be at least 8 characters' };
    }
    
    const newHash = await hashPassword(newPassword);
    db.updateUserPassword(userId, newHash);
    
    return { success: true };
}

/**
 * Validate password strength
 */
function validatePasswordStrength(password) {
    const result = {
        score: 0,
        feedback: []
    };
    
    if (password.length >= 8) result.score += 1;
    else result.feedback.push('Use at least 8 characters');
    
    if (password.length >= 12) result.score += 1;
    
    if (/[a-z]/.test(password)) result.score += 1;
    else result.feedback.push('Add lowercase letters');
    
    if (/[A-Z]/.test(password)) result.score += 1;
    else result.feedback.push('Add uppercase letters');
    
    if (/[0-9]/.test(password)) result.score += 1;
    else result.feedback.push('Add numbers');
    
    if (/[^a-zA-Z0-9]/.test(password)) result.score += 1;
    else result.feedback.push('Add special characters');
    
    result.strength = result.score <= 2 ? 'weak' : result.score <= 4 ? 'medium' : 'strong';
    
    return result;
}

// ==================== TOTP (2FA) Functions ====================

/**
 * Generate TOTP secret and QR code for user setup
 */
async function generateTotpSetup(userId) {
    const user = db.getUserById(userId);
    if (!user) {
        return { success: false, error: 'User not found' };
    }
    
    // Generate secret
    const secret = authenticator.generateSecret();
    
    // Save secret to DB (not yet enabled)
    db.saveTotpSecret(userId, secret);
    
    // Generate otpauth URI
    const otpauthUrl = authenticator.keyuri(user.username, 'BetterDesk Console', secret);
    
    // Generate QR code as data URL
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl, {
        width: 256,
        margin: 2,
        color: {
            dark: '#000000',
            light: '#ffffff'
        }
    });
    
    return {
        success: true,
        secret,
        qrCode: qrCodeDataUrl,
        otpauthUrl
    };
}

/**
 * Verify TOTP code and enable 2FA
 */
function verifyAndEnableTotp(userId, token) {
    const user = db.getUserById(userId);
    if (!user || !user.totp_secret) {
        return { success: false, error: 'TOTP not set up' };
    }
    
    // Verify the token against the stored secret
    const isValid = authenticator.verify({
        token,
        secret: user.totp_secret
    });
    
    if (!isValid) {
        return { success: false, error: 'Invalid verification code' };
    }
    
    // Generate recovery codes
    const recoveryCodes = generateRecoveryCodes(8);
    
    // Enable TOTP
    db.enableTotp(userId, recoveryCodes);
    
    return {
        success: true,
        recoveryCodes
    };
}

/**
 * Verify TOTP code during login
 */
function verifyTotpCode(userId, token) {
    const user = db.getUserById(userId);
    if (!user || !user.totp_enabled || !user.totp_secret) {
        return false;
    }
    
    const isValid = authenticator.verify({
        token,
        secret: user.totp_secret
    });
    
    return isValid;
}

/**
 * Verify recovery code during login
 */
function verifyRecoveryCode(userId, code) {
    const user = db.getUserById(userId);
    if (!user || !user.totp_enabled || !user.totp_recovery_codes) {
        return false;
    }
    
    let codes;
    try {
        codes = JSON.parse(user.totp_recovery_codes);
    } catch (e) {
        return false;
    }
    
    const normalizedCode = code.trim().toUpperCase();
    const index = codes.findIndex(c => c.toUpperCase() === normalizedCode);
    
    if (index === -1) {
        return false;
    }
    
    // Remove used code
    codes.splice(index, 1);
    db.useRecoveryCode(userId, codes);
    
    return true;
}

/**
 * Disable TOTP for user
 */
function disableTotp(userId) {
    db.disableTotp(userId);
    return { success: true };
}

/**
 * Check if user has TOTP enabled
 */
function isTotpEnabled(userId) {
    const user = db.getUserById(userId);
    return user ? !!user.totp_enabled : false;
}

/**
 * Generate random recovery codes
 */
function generateRecoveryCodes(count = 8) {
    const codes = [];
    for (let i = 0; i < count; i++) {
        const code = crypto.randomBytes(4).toString('hex').toUpperCase();
        codes.push(code.slice(0, 4) + '-' + code.slice(4));
    }
    return codes;
}

// ==================== RustDesk Client API Token Functions ====================

const TOKEN_EXPIRY_DAYS = parseInt(process.env.API_TOKEN_EXPIRY_DAYS, 10) || 7;
const MAX_FAILED_ATTEMPTS = parseInt(process.env.API_MAX_FAILED_ATTEMPTS, 10) || 10;
const LOCKOUT_MINUTES = parseInt(process.env.API_LOCKOUT_MINUTES, 10) || 15;
const IP_RATE_LIMIT = parseInt(process.env.API_IP_RATE_LIMIT, 10) || 30;
const ATTEMPT_WINDOW_MINUTES = parseInt(process.env.API_ATTEMPT_WINDOW, 10) || 15;

/**
 * Generate a secure access token for RustDesk client
 * Token format: 64 hex chars (256 bits of entropy)
 */
function generateAccessToken(userId, clientId, clientUuid, ipAddress) {
    // Revoke old tokens for the same client device
    db.revokeUserClientTokens(userId, clientId, clientUuid);

    // Generate cryptographically secure token
    const token = crypto.randomBytes(32).toString('hex');

    // Calculate expiry
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000)
        .toISOString().replace('T', ' ').replace('Z', '');

    db.createAccessToken(token, userId, clientId, clientUuid, expiresAt, ipAddress);

    return token;
}

/**
 * Validate an access token and return associated user
 */
function validateAccessToken(token) {
    if (!token || typeof token !== 'string' || token.length !== 64) {
        return null;
    }

    const tokenRecord = db.getAccessToken(token);
    if (!tokenRecord) {
        return null;
    }

    const user = db.getUserById(tokenRecord.user_id);
    if (!user) {
        return null;
    }

    // Update last_used
    db.touchAccessToken(token);

    return {
        id: user.id,
        username: user.username,
        role: user.role,
        clientId: tokenRecord.client_id,
        clientUuid: tokenRecord.client_uuid
    };
}

/**
 * Revoke all tokens for a user+client during logout
 */
function revokeClientTokens(userId, clientId, clientUuid) {
    if (clientId && clientUuid) {
        db.revokeUserClientTokens(userId, clientId, clientUuid);
    } else {
        db.revokeAllUserTokens(userId);
    }
}

// ==================== Brute-Force Protection ====================

/**
 * Check if login should be blocked (account lockout or IP rate limit)
 * Returns { blocked: boolean, reason: string, retryAfter: number }
 */
function checkBruteForce(username, ipAddress) {
    // Check account lockout
    if (username) {
        const lockout = db.getAccountLockout(username);
        if (lockout) {
            const retryAfter = Math.ceil(
                (new Date(lockout.locked_until + 'Z').getTime() - Date.now()) / 1000
            );
            return {
                blocked: true,
                reason: 'Account temporarily locked due to too many failed attempts',
                retryAfter: Math.max(retryAfter, 1)
            };
        }
    }

    // Check IP rate limiting
    if (ipAddress) {
        const ipAttempts = db.countRecentFailedAttemptsFromIp(ipAddress, ATTEMPT_WINDOW_MINUTES);
        if (ipAttempts >= IP_RATE_LIMIT) {
            return {
                blocked: true,
                reason: 'Too many failed attempts from this IP address',
                retryAfter: ATTEMPT_WINDOW_MINUTES * 60
            };
        }
    }

    return { blocked: false };
}

/**
 * Record a login attempt and potentially lock account
 */
function recordAttempt(username, ipAddress, success) {
    db.recordLoginAttempt(username, ipAddress, success);

    if (success) {
        // Clear lockout on successful login
        db.clearAccountLockout(username);
        return;
    }

    // Check if we need to lock the account
    const failedCount = db.countRecentFailedAttempts(username, ATTEMPT_WINDOW_MINUTES);
    if (failedCount >= MAX_FAILED_ATTEMPTS) {
        const lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000)
            .toISOString().replace('T', ' ').replace('Z', '');
        db.lockAccount(username, lockedUntil, failedCount);
    }
}

/**
 * Run periodic housekeeping (expired tokens, old attempts)
 */
function cleanupHousekeeping() {
    try {
        db.cleanupExpiredTokens();
        db.cleanupOldLoginAttempts();
    } catch (err) {
        console.error('Housekeeping error:', err.message);
    }
}

module.exports = {
    hashPassword,
    verifyPassword,
    authenticate,
    ensureDefaultAdmin,
    changePassword,
    validatePasswordStrength,
    // TOTP
    generateTotpSetup,
    verifyAndEnableTotp,
    verifyTotpCode,
    verifyRecoveryCode,
    disableTotp,
    isTotpEnabled,
    // RustDesk Client API tokens
    generateAccessToken,
    validateAccessToken,
    revokeClientTokens,
    // Brute-force protection
    checkBruteForce,
    recordAttempt,
    cleanupHousekeeping
};
