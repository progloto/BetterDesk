/**
 * BetterDesk Console - Database Service
 * SQLite3 wrapper using better-sqlite3 (synchronous, fast)
 */

const Database = require('better-sqlite3');
const path = require('path');
const config = require('../config/config');

let db = null;
let authDb = null;

/**
 * Escape special characters in LIKE patterns to prevent SQL injection.
 * Characters % and _ have special meaning in SQL LIKE clauses.
 * @param {string} str - The string to escape
 * @returns {string} - Escaped string safe for LIKE patterns
 */
function escapeLikePattern(str) {
    if (!str) return '';
    return str.replace(/[%_\\]/g, '\\$&');
}

/**
 * Get the main RustDesk database connection
 */
function getDb() {
    if (!db) {
        db = new Database(config.dbPath, {
            readonly: false,
            fileMustExist: false
        });
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
        
        // Ensure peer table exists with all columns
        ensurePeerTable(db);
    }
    return db;
}

/**
 * Get the auth database connection (separate from RustDesk data)
 */
function getAuthDb() {
    if (!authDb) {
        const authDbPath = path.join(config.dataDir, 'auth.db');
        authDb = new Database(authDbPath, {
            readonly: false,
            fileMustExist: false
        });
        authDb.pragma('journal_mode = WAL');
        
        // Initialize auth tables
        initAuthTables(authDb);
    }
    return authDb;
}

/**
 * Ensure peer table has all required columns
 */
function ensurePeerTable(db) {
    // Create table if not exists
    db.exec(`
        CREATE TABLE IF NOT EXISTS peer (
            id TEXT PRIMARY KEY,
            uuid TEXT DEFAULT '',
            pk BLOB,
            note TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now')),
            status_online INTEGER DEFAULT 0,
            last_online TEXT,
            is_deleted INTEGER DEFAULT 0,
            info TEXT DEFAULT '',
            ip TEXT DEFAULT '',
            user TEXT DEFAULT '',
            is_banned INTEGER DEFAULT 0,
            banned_at TEXT,
            banned_reason TEXT DEFAULT ''
        )
    `);
    
    // Add missing columns if they don't exist
    const columns = [
        { name: 'status_online', sql: 'INTEGER DEFAULT 0' },
        { name: 'last_online', sql: 'TEXT' },
        { name: 'is_deleted', sql: 'INTEGER DEFAULT 0' },
        { name: 'user', sql: 'TEXT DEFAULT \'\'' },
        { name: 'is_banned', sql: 'INTEGER DEFAULT 0' },
        { name: 'banned_at', sql: 'TEXT' },
        { name: 'banned_reason', sql: 'TEXT DEFAULT \'\'' },
        { name: 'folder_id', sql: 'INTEGER DEFAULT NULL' }
    ];
    
    const tableInfo = db.prepare("PRAGMA table_info(peer)").all();
    const existingColumns = new Set(tableInfo.map(c => c.name));
    
    for (const col of columns) {
        if (!existingColumns.has(col.name)) {
            try {
                db.exec(`ALTER TABLE peer ADD COLUMN ${col.name} ${col.sql}`);
                console.log(`Added column ${col.name} to peer table`);
            } catch (err) {
                // Column might already exist
            }
        }
    }
}

/**
 * Initialize authentication tables
 */
function initAuthTables(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT DEFAULT 'admin',
            created_at TEXT DEFAULT (datetime('now')),
            last_login TEXT
        )
    `);
    
    db.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            action TEXT NOT NULL,
            details TEXT,
            ip_address TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);
    
    // Add TOTP columns if they don't exist
    const userColumns = db.prepare("PRAGMA table_info(users)").all();
    const existingUserCols = new Set(userColumns.map(c => c.name));
    const totpColumns = [
        { name: 'totp_secret', sql: 'TEXT DEFAULT NULL' },
        { name: 'totp_enabled', sql: 'INTEGER DEFAULT 0' },
        { name: 'totp_recovery_codes', sql: 'TEXT DEFAULT NULL' }
    ];
    for (const col of totpColumns) {
        if (!existingUserCols.has(col.name)) {
            try {
                db.exec(`ALTER TABLE users ADD COLUMN ${col.name} ${col.sql}`);
                console.log(`Added column ${col.name} to users table`);
            } catch (err) {
                // Column might already exist
            }
        }
    }

    // Access tokens table for RustDesk client API (port 21121)
    db.exec(`
        CREATE TABLE IF NOT EXISTS access_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token TEXT UNIQUE NOT NULL,
            user_id INTEGER NOT NULL,
            client_id TEXT DEFAULT '',
            client_uuid TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now')),
            expires_at TEXT NOT NULL,
            last_used TEXT,
            ip_address TEXT DEFAULT '',
            revoked INTEGER DEFAULT 0,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    // Login attempts tracking (brute-force protection)
    db.exec(`
        CREATE TABLE IF NOT EXISTS login_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            ip_address TEXT DEFAULT '',
            success INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);

    // Account lockout table
    db.exec(`
        CREATE TABLE IF NOT EXISTS account_lockouts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            locked_until TEXT NOT NULL,
            attempt_count INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);

    // Device folders table
    db.exec(`
        CREATE TABLE IF NOT EXISTS folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            color TEXT DEFAULT '#6366f1',
            icon TEXT DEFAULT 'folder',
            sort_order INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);

    // Device-to-folder assignments (stored in auth.db so it works with any backend)
    db.exec(`
        CREATE TABLE IF NOT EXISTS device_folder_assignments (
            device_id TEXT PRIMARY KEY NOT NULL,
            folder_id INTEGER NOT NULL,
            assigned_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
        )
    `);

    // Address books table for RustDesk client sync
    db.exec(`
        CREATE TABLE IF NOT EXISTS address_books (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            ab_type TEXT DEFAULT 'legacy',
            data TEXT DEFAULT '{}',
            updated_at TEXT DEFAULT (datetime('now')),
            UNIQUE(user_id, ab_type),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    // Console settings key-value store (server backend choice, etc.)
    db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT DEFAULT (datetime('now'))
        )
    `);

    // ==================== RustDesk Client Integration Tables ====================

    // Peer sysinfo — hardware/software details reported by RustDesk client
    db.exec(`
        CREATE TABLE IF NOT EXISTS peer_sysinfo (
            peer_id TEXT PRIMARY KEY,
            hostname TEXT DEFAULT '',
            username TEXT DEFAULT '',
            platform TEXT DEFAULT '',
            version TEXT DEFAULT '',
            cpu_name TEXT DEFAULT '',
            cpu_cores INTEGER DEFAULT 0,
            cpu_freq_ghz REAL DEFAULT 0,
            memory_gb REAL DEFAULT 0,
            os_full TEXT DEFAULT '',
            displays TEXT DEFAULT '[]',
            encoding TEXT DEFAULT '[]',
            features TEXT DEFAULT '{}',
            platform_additions TEXT DEFAULT '{}',
            raw_json TEXT DEFAULT '{}',
            updated_at TEXT DEFAULT (datetime('now'))
        )
    `);

    // Peer metrics — heartbeat telemetry (cpu/memory/disk usage)
    db.exec(`
        CREATE TABLE IF NOT EXISTS peer_metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            peer_id TEXT NOT NULL,
            cpu_usage REAL DEFAULT 0,
            memory_usage REAL DEFAULT 0,
            disk_usage REAL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);
    // Index for efficient time-range queries
    db.exec(`CREATE INDEX IF NOT EXISTS idx_peer_metrics_peer_time ON peer_metrics (peer_id, created_at)`);

    // Audit: connection events — who connected where and when
    db.exec(`
        CREATE TABLE IF NOT EXISTS audit_connections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            host_id TEXT NOT NULL,
            host_uuid TEXT DEFAULT '',
            peer_id TEXT DEFAULT '',
            peer_name TEXT DEFAULT '',
            action TEXT NOT NULL,
            conn_type INTEGER DEFAULT 0,
            session_id TEXT DEFAULT '',
            ip TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_conn_host ON audit_connections (host_id, created_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_conn_peer ON audit_connections (peer_id, created_at)`);

    // Audit: file transfer events — what files were transferred
    db.exec(`
        CREATE TABLE IF NOT EXISTS audit_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            host_id TEXT NOT NULL,
            host_uuid TEXT DEFAULT '',
            peer_id TEXT DEFAULT '',
            direction INTEGER DEFAULT 0,
            path TEXT DEFAULT '',
            is_file INTEGER DEFAULT 1,
            num_files INTEGER DEFAULT 0,
            files_json TEXT DEFAULT '[]',
            ip TEXT DEFAULT '',
            peer_name TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_files_host ON audit_files (host_id, created_at)`);

    // Audit: security alarms — failed access, brute-force, IP violations
    db.exec(`
        CREATE TABLE IF NOT EXISTS audit_alarms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            alarm_type INTEGER NOT NULL,
            alarm_name TEXT DEFAULT '',
            host_id TEXT DEFAULT '',
            peer_id TEXT DEFAULT '',
            ip TEXT DEFAULT '',
            details TEXT DEFAULT '{}',
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_alarms_type ON audit_alarms (alarm_type, created_at)`);

    // User groups — RustDesk-compatible group management
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guid TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            note TEXT DEFAULT '',
            team_id TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);

    // Device groups — group devices by function/location/team
    db.exec(`
        CREATE TABLE IF NOT EXISTS device_groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guid TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            note TEXT DEFAULT '',
            team_id TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);

    // Device-to-group membership (many-to-many)
    db.exec(`
        CREATE TABLE IF NOT EXISTS device_group_members (
            device_group_id INTEGER NOT NULL,
            peer_id TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (device_group_id, peer_id),
            FOREIGN KEY (device_group_id) REFERENCES device_groups(id) ON DELETE CASCADE
        )
    `);

    // Access strategies / policies — RustDesk-compatible permission rules
    db.exec(`
        CREATE TABLE IF NOT EXISTS strategies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guid TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            user_group_guid TEXT DEFAULT '',
            device_group_guid TEXT DEFAULT '',
            enabled INTEGER DEFAULT 1,
            permissions TEXT DEFAULT '{}',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        )
    `);

    // Seed default groups if empty
    const ugCount = db.prepare('SELECT COUNT(*) as c FROM user_groups').get().c;
    if (ugCount === 0) {
        const crypto = require('crypto');
        db.prepare('INSERT INTO user_groups (guid, name, note) VALUES (?, ?, ?)').run(
            crypto.randomUUID(), 'Default', 'Default user group'
        );
    }
    const dgCount = db.prepare('SELECT COUNT(*) as c FROM device_groups').get().c;
    if (dgCount === 0) {
        const crypto = require('crypto');
        db.prepare('INSERT INTO device_groups (guid, name, note) VALUES (?, ?, ?)').run(
            crypto.randomUUID(), 'Default', 'Default device group'
        );
    }

    // Cleanup old metrics (keep last 7 days) — scheduled in housekeeping
    db.exec(`
        DELETE FROM peer_metrics WHERE created_at < datetime('now', '-7 days')
    `);
}

// ==================== Device Operations ====================

/**
 * Parse info JSON and extract useful fields
 */
function parseDeviceInfo(device) {
    if (!device) return device;
    
    let info = {};
    if (device.info) {
        try {
            info = JSON.parse(device.info);
        } catch (e) {
            // Not valid JSON
        }
    }
    
    return {
        id: device.id,
        hostname: device.note || info.hostname || '',
        username: typeof device.user === 'string' ? device.user : '',
        platform: info.os || info.platform || '',
        ip: info.ip || '',
        note: device.note || '',
        online: device.status_online === 1,
        banned: device.is_banned === 1,
        created_at: device.created_at,
        last_online: device.last_online,
        ban_reason: device.ban_reason || device.banned_reason || '',
        folder_id: device.folder_id || null,
        pk: device.pk ? Buffer.from(device.pk).toString('base64') : ''
    };
}

/**
 * Get all devices with optional filtering
 */
function getAllDevices(filters = {}) {
    const db = getDb();
    let sql = 'SELECT * FROM peer WHERE is_deleted = 0';
    const params = [];
    
    // Search filter (escape % and _ to prevent LIKE injection)
    if (filters.search) {
        sql += " AND (id LIKE ? ESCAPE '\\' OR user LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\')";
        const escaped = escapeLikePattern(filters.search);
        const search = `%${escaped}%`;
        params.push(search, search, search);
    }
    
    // Status filter
    if (filters.status === 'online') {
        sql += ' AND status_online = 1';
    } else if (filters.status === 'offline') {
        sql += ' AND status_online = 0 AND is_banned = 0';
    } else if (filters.status === 'banned') {
        sql += ' AND is_banned = 1';
    }
    
    // Notes filter
    if (filters.hasNotes) {
        sql += " AND note IS NOT NULL AND note != ''";
    }
    
    // Sorting
    const sortColumn = filters.sortBy || 'last_online';
    const sortOrder = filters.sortOrder === 'asc' ? 'ASC' : 'DESC';
    const allowedColumns = ['id', 'user', 'created_at', 'last_online', 'status_online'];
    if (allowedColumns.includes(sortColumn)) {
        sql += ` ORDER BY ${sortColumn} ${sortOrder} NULLS LAST`;
    } else {
        sql += ' ORDER BY last_online DESC NULLS LAST';
    }
    
    // Note: No pagination in SQL - we load all and paginate client-side for filtering
    const rawDevices = db.prepare(sql).all(...params);
    
    // Transform to consistent format
    return rawDevices.map(parseDeviceInfo);
}

/**
 * Get device by ID
 */
function getDeviceById(id) {
    const device = getDb().prepare('SELECT * FROM peer WHERE id = ? AND is_deleted = 0').get(id);
    return parseDeviceInfo(device);
}

/**
 * Update device (user name, note)
 */
function updateDevice(id, data) {
    const fields = [];
    const params = [];
    
    if (data.user !== undefined) {
        fields.push('user = ?');
        params.push(data.user);
    }
    if (data.note !== undefined) {
        fields.push('note = ?');
        params.push(data.note);
    }
    
    if (fields.length === 0) return { changes: 0 };
    
    params.push(id);
    return getDb().prepare(`UPDATE peer SET ${fields.join(', ')} WHERE id = ?`).run(...params);
}

/**
 * Soft delete device
 */
function deleteDevice(id) {
    return getDb().prepare('UPDATE peer SET is_deleted = 1 WHERE id = ?').run(id);
}

/**
 * Ban/unban device
 */
function setBanStatus(id, banned, reason = '') {
    if (banned) {
        return getDb().prepare(
            'UPDATE peer SET is_banned = 1, banned_at = datetime(\'now\'), banned_reason = ? WHERE id = ?'
        ).run(reason, id);
    } else {
        return getDb().prepare(
            'UPDATE peer SET is_banned = 0, banned_at = NULL, banned_reason = \'\' WHERE id = ?'
        ).run(id);
    }
}

/**
 * Get device statistics
 */
function getStats() {
    const db = getDb();
    const total = db.prepare('SELECT COUNT(*) as count FROM peer WHERE is_deleted = 0').get().count;
    const online = db.prepare('SELECT COUNT(*) as count FROM peer WHERE is_deleted = 0 AND status_online = 1').get().count;
    const banned = db.prepare('SELECT COUNT(*) as count FROM peer WHERE is_deleted = 0 AND is_banned = 1').get().count;
    const withNotes = db.prepare("SELECT COUNT(*) as count FROM peer WHERE is_deleted = 0 AND note IS NOT NULL AND note != ''").get().count;
    
    return {
        total,
        online,
        offline: total - online,
        banned,
        withNotes
    };
}

/**
 * Count devices matching filters (for pagination)
 */
function countDevices(filters = {}) {
    const db = getDb();
    let sql = 'SELECT COUNT(*) as count FROM peer WHERE is_deleted = 0';
    const params = [];
    
    if (filters.search) {
        sql += " AND (id LIKE ? ESCAPE '\\' OR user LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\' OR ip LIKE ? ESCAPE '\\')";
        const escaped = escapeLikePattern(filters.search);
        const search = `%${escaped}%`;
        params.push(search, search, search, search);
    }
    
    if (filters.status === 'online') {
        sql += ' AND status_online = 1';
    } else if (filters.status === 'offline') {
        sql += ' AND status_online = 0';
    } else if (filters.status === 'banned') {
        sql += ' AND is_banned = 1';
    }
    
    if (filters.hasNotes) {
        sql += " AND note IS NOT NULL AND note != ''";
    }
    
    return db.prepare(sql).get(...params).count;
}

// ==================== User Operations ====================

/**
 * Get user by username
 */
function getUserByUsername(username) {
    return getAuthDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
}

/**
 * Get user by ID
 */
function getUserById(id) {
    return getAuthDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
}

/**
 * Create user
 */
function createUser(username, passwordHash, role = 'admin') {
    return getAuthDb().prepare(
        'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
    ).run(username, passwordHash, role);
}

/**
 * Update user password
 */
function updateUserPassword(id, passwordHash) {
    return getAuthDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
}

// ==================== TOTP Operations ====================

/**
 * Save TOTP secret for user
 */
function saveTotpSecret(userId, secret) {
    return getAuthDb().prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret, userId);
}

/**
 * Enable TOTP for user
 */
function enableTotp(userId, recoveryCodes) {
    return getAuthDb().prepare(
        'UPDATE users SET totp_enabled = 1, totp_recovery_codes = ? WHERE id = ?'
    ).run(JSON.stringify(recoveryCodes), userId);
}

/**
 * Disable TOTP for user
 */
function disableTotp(userId) {
    return getAuthDb().prepare(
        'UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_recovery_codes = NULL WHERE id = ?'
    ).run(userId);
}

/**
 * Use a recovery code (mark as used)
 */
function useRecoveryCode(userId, updatedCodes) {
    return getAuthDb().prepare(
        'UPDATE users SET totp_recovery_codes = ? WHERE id = ?'
    ).run(JSON.stringify(updatedCodes), userId);
}

/**
 * Update last login
 */
function updateLastLogin(id) {
    return getAuthDb().prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(id);
}

/**
 * Check if any users exist
 */
function hasUsers() {
    return getAuthDb().prepare('SELECT COUNT(*) as count FROM users').get().count > 0;
}

// ==================== Audit Log ====================

/**
 * Log an action
 */
function logAction(userId, action, details, ipAddress) {
    return getAuthDb().prepare(
        'INSERT INTO audit_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)'
    ).run(userId, action, details, ipAddress);
}

/**
 * Get recent audit logs
 */
function getAuditLogs(limit = 100) {
    return getAuthDb().prepare(
        'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?'
    ).all(limit);
}

// ==================== Extended User Operations ====================

/**
 * Get all users
 */
function getAllUsers() {
    return getAuthDb().prepare('SELECT * FROM users ORDER BY created_at DESC').all();
}

/**
 * Update user role
 */
function updateUserRole(id, role) {
    return getAuthDb().prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
}

/**
 * Delete user
 */
function deleteUser(id) {
    return getAuthDb().prepare('DELETE FROM users WHERE id = ?').run(id);
}

/**
 * Count admins
 */
function countAdmins() {
    return getAuthDb().prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get().count;
}

/**
 * Force reset admin password (for installation scripts)
 */
function resetAdminPassword(passwordHash) {
    const admin = getAuthDb().prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get();
    if (admin) {
        return getAuthDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, admin.id);
    }
    return null;
}

/**
 * Delete all users (for fresh install)
 */
function deleteAllUsers() {
    return getAuthDb().prepare('DELETE FROM users').run();
}

// ==================== Folder Operations ====================

/**
 * Get all folders
 */
function getAllFolders() {
    const db = getAuthDb();
    const folders = db.prepare('SELECT * FROM folders ORDER BY sort_order ASC, name ASC').all();
    
    // Get device count per folder from auth.db assignments table
    return folders.map(folder => {
        const count = db.prepare(
            'SELECT COUNT(*) as count FROM device_folder_assignments WHERE folder_id = ?'
        ).get(folder.id);
        return {
            ...folder,
            device_count: count?.count || 0
        };
    });
}

/**
 * Get folder by ID
 */
function getFolderById(id) {
    return getAuthDb().prepare('SELECT * FROM folders WHERE id = ?').get(id);
}

/**
 * Create folder
 */
function createFolder(name, color, icon) {
    return getAuthDb().prepare(
        'INSERT INTO folders (name, color, icon) VALUES (?, ?, ?)'
    ).run(name, color, icon);
}

/**
 * Update folder
 */
function updateFolder(id, updates) {
    const sets = [];
    const params = [];
    
    if (updates.name !== undefined) {
        sets.push('name = ?');
        params.push(updates.name);
    }
    if (updates.color !== undefined) {
        sets.push('color = ?');
        params.push(updates.color);
    }
    if (updates.icon !== undefined) {
        sets.push('icon = ?');
        params.push(updates.icon);
    }
    if (updates.sort_order !== undefined) {
        sets.push('sort_order = ?');
        params.push(updates.sort_order);
    }
    
    if (sets.length === 0) return;
    
    params.push(id);
    return getAuthDb().prepare(
        `UPDATE folders SET ${sets.join(', ')} WHERE id = ?`
    ).run(...params);
}

/**
 * Delete folder
 */
function deleteFolder(id) {
    return getAuthDb().prepare('DELETE FROM folders WHERE id = ?').run(id);
}

/**
 * Assign single device to folder
 */
function assignDeviceToFolder(deviceId, folderId) {
    const db = getAuthDb();
    if (folderId === null || folderId === undefined) {
        // Unassign: remove from assignments table
        return db.prepare('DELETE FROM device_folder_assignments WHERE device_id = ?').run(deviceId);
    }
    // Upsert assignment in auth.db
    return db.prepare(
        'INSERT INTO device_folder_assignments (device_id, folder_id) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET folder_id = ?, assigned_at = datetime(\'now\')'
    ).run(deviceId, folderId, folderId);
}

/**
 * Assign multiple devices to folder
 */
function assignDevicesToFolder(deviceIds, folderId) {
    const db = getAuthDb();
    if (folderId === null || folderId === undefined) {
        const stmt = db.prepare('DELETE FROM device_folder_assignments WHERE device_id = ?');
        const unassignAll = db.transaction((ids) => {
            for (const id of ids) {
                stmt.run(id);
            }
        });
        return unassignAll(deviceIds);
    }
    const stmt = db.prepare(
        'INSERT INTO device_folder_assignments (device_id, folder_id) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET folder_id = ?, assigned_at = datetime(\'now\')'
    );
    const assignAll = db.transaction((ids) => {
        for (const id of ids) {
            stmt.run(id, folderId, folderId);
        }
    });
    return assignAll(deviceIds);
}

/**
 * Unassign all devices from folder
 */
function unassignDevicesFromFolder(folderId) {
    return getAuthDb().prepare('DELETE FROM device_folder_assignments WHERE folder_id = ?').run(folderId);
}

/**
 * Get unassigned device count
 * Note: This requires total device count passed externally when using Go backend.
 * Falls back to local peer table count when available.
 */
function getUnassignedDeviceCount() {
    try {
        const mainDb = getDb();
        const total = mainDb.prepare(
            'SELECT COUNT(*) as count FROM peer WHERE is_deleted = 0'
        ).get().count;
        const assigned = getAuthDb().prepare(
            'SELECT COUNT(*) as count FROM device_folder_assignments'
        ).get().count;
        return Math.max(0, total - assigned);
    } catch {
        // If main DB is unavailable (BetterDesk mode), return -1 to signal unknown
        return -1;
    }
}

/**
 * Get all device folder assignments as a map { device_id: folder_id }
 */
function getAllFolderAssignments() {
    const rows = getAuthDb().prepare('SELECT device_id, folder_id FROM device_folder_assignments').all();
    const map = {};
    for (const row of rows) {
        map[row.device_id] = row.folder_id;
    }
    return map;
}

// ==================== Access Token Operations ====================

/**
 * Create an access token for RustDesk client API
 */
function createAccessToken(token, userId, clientId, clientUuid, expiresAt, ipAddress) {
    return getAuthDb().prepare(
        'INSERT INTO access_tokens (token, user_id, client_id, client_uuid, expires_at, ip_address) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(token, userId, clientId || '', clientUuid || '', expiresAt, ipAddress || '');
}

/**
 * Get access token record (non-revoked, non-expired)
 */
function getAccessToken(token) {
    return getAuthDb().prepare(
        "SELECT * FROM access_tokens WHERE token = ? AND revoked = 0 AND expires_at > datetime('now')"
    ).get(token);
}

/**
 * Update last_used timestamp for token
 */
function touchAccessToken(token) {
    return getAuthDb().prepare(
        "UPDATE access_tokens SET last_used = datetime('now') WHERE token = ?"
    ).run(token);
}

/**
 * Revoke a specific token
 */
function revokeAccessToken(token) {
    return getAuthDb().prepare(
        'UPDATE access_tokens SET revoked = 1 WHERE token = ?'
    ).run(token);
}

/**
 * Revoke all tokens for a user + client combo
 */
function revokeUserClientTokens(userId, clientId, clientUuid) {
    return getAuthDb().prepare(
        'UPDATE access_tokens SET revoked = 1 WHERE user_id = ? AND client_id = ? AND client_uuid = ?'
    ).run(userId, clientId || '', clientUuid || '');
}

/**
 * Revoke all tokens for a user
 */
function revokeAllUserTokens(userId) {
    return getAuthDb().prepare(
        'UPDATE access_tokens SET revoked = 1 WHERE user_id = ?'
    ).run(userId);
}

/**
 * Cleanup expired tokens (housekeeping)
 */
function cleanupExpiredTokens() {
    return getAuthDb().prepare(
        "DELETE FROM access_tokens WHERE expires_at < datetime('now') OR revoked = 1"
    ).run();
}

// ==================== Login Attempt Tracking ====================

/**
 * Record a login attempt
 */
function recordLoginAttempt(username, ipAddress, success) {
    return getAuthDb().prepare(
        'INSERT INTO login_attempts (username, ip_address, success) VALUES (?, ?, ?)'
    ).run(username, ipAddress || '', success ? 1 : 0);
}

/**
 * Count recent failed attempts for a username (within window)
 */
function countRecentFailedAttempts(username, windowMinutes) {
    const result = getAuthDb().prepare(
        "SELECT COUNT(*) as count FROM login_attempts WHERE username = ? AND success = 0 AND created_at > datetime('now', ? || ' minutes')"
    ).get(username, `-${windowMinutes}`);
    return result ? result.count : 0;
}

/**
 * Count recent failed attempts from an IP (within window)
 */
function countRecentFailedAttemptsFromIp(ipAddress, windowMinutes) {
    const result = getAuthDb().prepare(
        "SELECT COUNT(*) as count FROM login_attempts WHERE ip_address = ? AND success = 0 AND created_at > datetime('now', ? || ' minutes')"
    ).get(ipAddress, `-${windowMinutes}`);
    return result ? result.count : 0;
}

/**
 * Lock an account
 */
function lockAccount(username, lockedUntil, attemptCount) {
    return getAuthDb().prepare(
        'INSERT OR REPLACE INTO account_lockouts (username, locked_until, attempt_count) VALUES (?, ?, ?)'
    ).run(username, lockedUntil, attemptCount);
}

/**
 * Check if account is locked
 */
function getAccountLockout(username) {
    return getAuthDb().prepare(
        "SELECT * FROM account_lockouts WHERE username = ? AND locked_until > datetime('now')"
    ).get(username);
}

/**
 * Clear account lockout
 */
function clearAccountLockout(username) {
    return getAuthDb().prepare(
        'DELETE FROM account_lockouts WHERE username = ?'
    ).run(username);
}

/**
 * Cleanup old login attempts (older than 24h)
 */
function cleanupOldLoginAttempts() {
    return getAuthDb().prepare(
        "DELETE FROM login_attempts WHERE created_at < datetime('now', '-24 hours')"
    ).run();
}

// ==================== Address Book Operations ====================

/**
 * Get address book data for a user
 * @param {number} userId
 * @param {string} abType - 'legacy' or 'personal'
 * @returns {string} JSON string of address book data
 */
function getAddressBook(userId, abType = 'legacy') {
    const row = getAuthDb().prepare(
        'SELECT data FROM address_books WHERE user_id = ? AND ab_type = ?'
    ).get(userId, abType);
    return row ? row.data : '{}';
}

/**
 * Save address book data for a user
 * @param {number} userId
 * @param {string} data - JSON string
 * @param {string} abType - 'legacy' or 'personal'
 */
function saveAddressBook(userId, data, abType = 'legacy') {
    return getAuthDb().prepare(`
        INSERT INTO address_books (user_id, ab_type, data, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(user_id, ab_type)
        DO UPDATE SET data = excluded.data, updated_at = datetime('now')
    `).run(userId, abType, data);
}

/**
 * Get address book tags for a user
 * @param {number} userId
 * @returns {string[]} Array of tags
 */
function getAddressBookTags(userId) {
    const data = getAddressBook(userId, 'legacy');
    try {
        const parsed = JSON.parse(data);
        return parsed.tags || [];
    } catch {
        return [];
    }
}

// ==================== Console Settings ====================

/**
 * Get a console setting by key
 * @param {string} key
 * @param {string} [defaultValue] - Fallback if key not found
 * @returns {string|null}
 */
function getSetting(key, defaultValue = null) {
    const row = getAuthDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : defaultValue;
}

/**
 * Save a console setting (upsert)
 * @param {string} key
 * @param {string} value
 */
function setSetting(key, value) {
    return getAuthDb().prepare(`
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(key)
        DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).run(key, value);
}

/**
 * Get all console settings
 * @returns {Object} key-value pairs
 */
function getAllSettings() {
    const rows = getAuthDb().prepare('SELECT key, value FROM settings').all();
    const result = {};
    for (const row of rows) {
        result[row.key] = row.value;
    }
    return result;
}

// ==================== Pending Registrations (LAN Discovery) ====================

function ensureRegistrationTable() {
    const mainDb = getDb();
    mainDb.exec(`
        CREATE TABLE IF NOT EXISTS pending_registrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL,
            hostname TEXT DEFAULT '',
            platform TEXT DEFAULT '',
            version TEXT DEFAULT '',
            ip_address TEXT DEFAULT '',
            public_key TEXT DEFAULT '',
            uuid TEXT DEFAULT '',
            status TEXT DEFAULT 'pending',
            approved_by TEXT DEFAULT NULL,
            approved_at TEXT DEFAULT NULL,
            rejected_reason TEXT DEFAULT '',
            access_token TEXT DEFAULT NULL,
            console_url TEXT DEFAULT NULL,
            server_address TEXT DEFAULT NULL,
            server_key TEXT DEFAULT NULL,
            created_at DATETIME DEFAULT (datetime('now')),
            updated_at DATETIME DEFAULT (datetime('now')),
            UNIQUE(device_id)
        );
        CREATE INDEX IF NOT EXISTS idx_pending_reg_status ON pending_registrations (status);
        CREATE INDEX IF NOT EXISTS idx_pending_reg_device ON pending_registrations (device_id);
    `);
}

// Call on module load to ensure table exists
try { ensureRegistrationTable(); } catch (_) { /* db not ready yet */ }

function getPendingRegistrations(filters = {}) {
    ensureRegistrationTable();
    const mainDb = getDb();
    let sql = 'SELECT * FROM pending_registrations WHERE 1=1';
    const params = [];

    if (filters.status) {
        sql += ' AND status = ?';
        params.push(filters.status);
    }
    if (filters.search) {
        sql += " AND (device_id LIKE ? ESCAPE '\\' OR hostname LIKE ? ESCAPE '\\' OR ip_address LIKE ? ESCAPE '\\')";
        const escaped = escapeLikePattern(filters.search);
        const s = `%${escaped}%`;
        params.push(s, s, s);
    }

    sql += ' ORDER BY created_at DESC';
    return mainDb.prepare(sql).all(...params);
}

function getPendingRegistrationById(id) {
    ensureRegistrationTable();
    return getDb().prepare('SELECT * FROM pending_registrations WHERE id = ?').get(id);
}

function getPendingRegistrationByDeviceId(deviceId) {
    ensureRegistrationTable();
    return getDb().prepare('SELECT * FROM pending_registrations WHERE device_id = ?').get(deviceId);
}

function createPendingRegistration(data) {
    ensureRegistrationTable();
    const mainDb = getDb();

    // Check if already exists
    const existing = mainDb.prepare('SELECT * FROM pending_registrations WHERE device_id = ?').get(data.device_id);
    if (existing) {
        if (existing.status === 'approved') {
            return existing; // Already approved — return as-is
        }
        // Update existing (reset to pending if rejected, or update fields)
        mainDb.prepare(`
            UPDATE pending_registrations
            SET hostname = ?, platform = ?, version = ?, ip_address = ?,
                public_key = ?, uuid = ?, status = 'pending',
                rejected_reason = '', updated_at = datetime('now')
            WHERE device_id = ?
        `).run(
            data.hostname || '', data.platform || '', data.version || '',
            data.ip_address || '', data.public_key || '', data.uuid || '',
            data.device_id
        );
        return mainDb.prepare('SELECT * FROM pending_registrations WHERE device_id = ?').get(data.device_id);
    }

    // Create new
    const result = mainDb.prepare(`
        INSERT INTO pending_registrations (device_id, hostname, platform, version, ip_address, public_key, uuid)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        data.device_id, data.hostname || '', data.platform || '',
        data.version || '', data.ip_address || '', data.public_key || '',
        data.uuid || ''
    );

    return mainDb.prepare('SELECT * FROM pending_registrations WHERE id = ?').get(result.lastInsertRowid);
}

function approvePendingRegistration(id, approvedBy, serverConfig) {
    ensureRegistrationTable();
    const mainDb = getDb();
    mainDb.prepare(`
        UPDATE pending_registrations
        SET status = 'approved', approved_by = ?, approved_at = datetime('now'),
            access_token = ?, console_url = ?, server_address = ?, server_key = ?,
            updated_at = datetime('now')
        WHERE id = ?
    `).run(
        approvedBy,
        serverConfig.access_token || '',
        serverConfig.console_url || '',
        serverConfig.server_address || '',
        serverConfig.server_key || '',
        id
    );
    return mainDb.prepare('SELECT * FROM pending_registrations WHERE id = ?').get(id);
}

function rejectPendingRegistration(id, reason) {
    ensureRegistrationTable();
    const mainDb = getDb();
    mainDb.prepare(`
        UPDATE pending_registrations
        SET status = 'rejected', rejected_reason = ?, updated_at = datetime('now')
        WHERE id = ?
    `).run(reason || '', id);
    return mainDb.prepare('SELECT * FROM pending_registrations WHERE id = ?').get(id);
}

function deletePendingRegistration(id) {
    ensureRegistrationTable();
    getDb().prepare('DELETE FROM pending_registrations WHERE id = ?').run(id);
}

function getPendingRegistrationCount() {
    ensureRegistrationTable();
    const row = getDb().prepare("SELECT COUNT(*) as count FROM pending_registrations WHERE status = 'pending'").get();
    return row ? row.count : 0;
}

// ==================== Peer Sysinfo Operations ====================

/**
 * Upsert peer system information (reported via POST /api/sysinfo)
 * @param {string} peerId - RustDesk device ID
 * @param {Object} data - Sysinfo payload from RustDesk client
 */
function upsertPeerSysinfo(peerId, data) {
    return getAuthDb().prepare(`
        INSERT INTO peer_sysinfo (peer_id, hostname, username, platform, version,
            cpu_name, cpu_cores, cpu_freq_ghz, memory_gb, os_full,
            displays, encoding, features, platform_additions, raw_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(peer_id) DO UPDATE SET
            hostname = excluded.hostname, username = excluded.username,
            platform = excluded.platform, version = excluded.version,
            cpu_name = excluded.cpu_name, cpu_cores = excluded.cpu_cores,
            cpu_freq_ghz = excluded.cpu_freq_ghz, memory_gb = excluded.memory_gb,
            os_full = excluded.os_full, displays = excluded.displays,
            encoding = excluded.encoding, features = excluded.features,
            platform_additions = excluded.platform_additions,
            raw_json = excluded.raw_json, updated_at = datetime('now')
    `).run(
        peerId,
        data.hostname || '',
        data.username || '',
        data.platform || '',
        data.version || '',
        data.cpu_name || '',
        data.cpu_cores || 0,
        data.cpu_freq_ghz || 0,
        data.memory_gb || 0,
        data.os_full || '',
        JSON.stringify(data.displays || []),
        JSON.stringify(data.encoding || []),
        JSON.stringify(data.features || {}),
        JSON.stringify(data.platform_additions || {}),
        JSON.stringify(data)
    );
}

/**
 * Get sysinfo for a single peer
 */
function getPeerSysinfo(peerId) {
    const row = getAuthDb().prepare('SELECT * FROM peer_sysinfo WHERE peer_id = ?').get(peerId);
    if (!row) return null;
    return parseSysinfoRow(row);
}

/**
 * Get sysinfo for all peers
 */
function getAllPeerSysinfo() {
    const rows = getAuthDb().prepare('SELECT * FROM peer_sysinfo').all();
    return rows.map(parseSysinfoRow);
}

/**
 * Parse sysinfo row — deserialize JSON fields
 */
function parseSysinfoRow(row) {
    return {
        peer_id: row.peer_id,
        hostname: row.hostname,
        username: row.username,
        platform: row.platform,
        version: row.version,
        cpu_name: row.cpu_name,
        cpu_cores: row.cpu_cores,
        cpu_freq_ghz: row.cpu_freq_ghz,
        memory_gb: row.memory_gb,
        os_full: row.os_full,
        displays: safeJsonParse(row.displays, []),
        encoding: safeJsonParse(row.encoding, []),
        features: safeJsonParse(row.features, {}),
        platform_additions: safeJsonParse(row.platform_additions, {}),
        updated_at: row.updated_at
    };
}

/**
 * Safe JSON parse with fallback
 */
function safeJsonParse(str, fallback) {
    try {
        return JSON.parse(str);
    } catch {
        return fallback;
    }
}

// ==================== Peer Metrics Operations ====================

/**
 * Update peer online status and last_online timestamp in the shared peer table.
 * Used by heartbeat handler to mark a device as online.
 */
function updatePeerOnlineStatus(peerId) {
    return getDb().prepare(
        "UPDATE peer SET status_online = 1, last_online = datetime('now'), last_heartbeat = datetime('now'), heartbeat_count = COALESCE(heartbeat_count, 0) + 1 WHERE id = ?"
    ).run(peerId);
}

/**
 * Mark peers as offline if their last_heartbeat is older than the given threshold.
 * This prevents stale "online" status when devices stop sending heartbeats.
 * @param {number} thresholdSeconds - seconds of inactivity before marking offline
 * @returns {{ changes: number }} number of peers marked offline
 */
function cleanupStaleOnlinePeers(thresholdSeconds = 90) {
    return getDb().prepare(
        `UPDATE peer SET status_online = 0
         WHERE status_online = 1
           AND last_heartbeat IS NOT NULL
           AND last_heartbeat < datetime('now', '-' || ? || ' seconds')`
    ).run(thresholdSeconds);
}

/**
 * Insert a heartbeat metric data point
 */
function insertPeerMetric(peerId, cpuUsage, memoryUsage, diskUsage) {
    return getAuthDb().prepare(
        'INSERT INTO peer_metrics (peer_id, cpu_usage, memory_usage, disk_usage) VALUES (?, ?, ?, ?)'
    ).run(peerId, cpuUsage || 0, memoryUsage || 0, diskUsage || 0);
}

/**
 * Get recent metrics for a peer
 * @param {string} peerId
 * @param {number} limit - Max records to return (default 100)
 */
function getPeerMetrics(peerId, limit = 100) {
    return getAuthDb().prepare(
        'SELECT * FROM peer_metrics WHERE peer_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(peerId, limit);
}

/**
 * Get latest metric for a peer (most recent heartbeat)
 */
function getLatestPeerMetric(peerId) {
    return getAuthDb().prepare(
        'SELECT * FROM peer_metrics WHERE peer_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(peerId);
}

/**
 * Cleanup old metrics (older than N days)
 * @param {number} days - Minimum 1, default 7
 */
function cleanupOldMetrics(days = 7) {
    const safeDays = Math.max(1, parseInt(days, 10) || 7);
    return getAuthDb().prepare(
        "DELETE FROM peer_metrics WHERE created_at < datetime('now', ? || ' days')"
    ).run(`-${safeDays}`);
}

// ==================== Audit Connection Operations ====================

/**
 * Insert a connection audit event
 * @param {Object} data - { host_id, host_uuid, peer_id, peer_name, action, conn_type, session_id, ip }
 */
function insertAuditConnection(data) {
    return getAuthDb().prepare(`
        INSERT INTO audit_connections (host_id, host_uuid, peer_id, peer_name, action, conn_type, session_id, ip)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        data.host_id || '',
        data.host_uuid || '',
        data.peer_id || '',
        data.peer_name || '',
        data.action || '',
        data.conn_type || 0,
        data.session_id || '',
        data.ip || ''
    );
}

/**
 * Query audit connections with filters
 * @param {Object} filters - { host_id, peer_id, action, limit, offset }
 */
function getAuditConnections(filters = {}) {
    let sql = 'SELECT * FROM audit_connections WHERE 1=1';
    const params = [];

    if (filters.host_id) {
        sql += ' AND host_id = ?';
        params.push(filters.host_id);
    }
    if (filters.peer_id) {
        sql += ' AND peer_id = ?';
        params.push(filters.peer_id);
    }
    if (filters.action) {
        sql += ' AND action = ?';
        params.push(filters.action);
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(filters.limit || 100);
    params.push(filters.offset || 0);

    return getAuthDb().prepare(sql).all(...params);
}

/**
 * Count audit connections (for pagination)
 */
function countAuditConnections(filters = {}) {
    let sql = 'SELECT COUNT(*) as count FROM audit_connections WHERE 1=1';
    const params = [];

    if (filters.host_id) {
        sql += ' AND host_id = ?';
        params.push(filters.host_id);
    }
    if (filters.peer_id) {
        sql += ' AND peer_id = ?';
        params.push(filters.peer_id);
    }
    if (filters.action) {
        sql += ' AND action = ?';
        params.push(filters.action);
    }

    return getAuthDb().prepare(sql).get(...params).count;
}

// ==================== Audit File Transfer Operations ====================

/**
 * Insert a file transfer audit event
 * @param {Object} data - { host_id, host_uuid, peer_id, direction, path, is_file, num_files, files_json, ip, peer_name }
 */
function insertAuditFile(data) {
    return getAuthDb().prepare(`
        INSERT INTO audit_files (host_id, host_uuid, peer_id, direction, path, is_file, num_files, files_json, ip, peer_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        data.host_id || '',
        data.host_uuid || '',
        data.peer_id || '',
        data.direction || 0,
        data.path || '',
        data.is_file !== undefined ? (data.is_file ? 1 : 0) : 1,
        data.num_files || 0,
        JSON.stringify(data.files || []),
        data.ip || '',
        data.peer_name || ''
    );
}

/**
 * Query file transfer audit events
 */
function getAuditFiles(filters = {}) {
    let sql = 'SELECT * FROM audit_files WHERE 1=1';
    const params = [];

    if (filters.host_id) {
        sql += ' AND host_id = ?';
        params.push(filters.host_id);
    }
    if (filters.peer_id) {
        sql += ' AND peer_id = ?';
        params.push(filters.peer_id);
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(filters.limit || 100);
    params.push(filters.offset || 0);

    return getAuthDb().prepare(sql).all(...params);
}

/**
 * Count file transfer audit events
 */
function countAuditFiles(filters = {}) {
    let sql = 'SELECT COUNT(*) as count FROM audit_files WHERE 1=1';
    const params = [];

    if (filters.host_id) {
        sql += ' AND host_id = ?';
        params.push(filters.host_id);
    }
    if (filters.peer_id) {
        sql += ' AND peer_id = ?';
        params.push(filters.peer_id);
    }

    return getAuthDb().prepare(sql).get(...params).count;
}

// ==================== Audit Alarm Operations ====================

/**
 * Insert a security alarm event
 * Alarm types: 0=AccessAttempt, 1=BruteForce, 2=IPViolation, 3=Unauthorized,
 *              4=PortScan, 5=MaliciousFile, 6=Custom
 * @param {Object} data - { alarm_type, alarm_name, host_id, peer_id, ip, details }
 */
function insertAuditAlarm(data) {
    return getAuthDb().prepare(`
        INSERT INTO audit_alarms (alarm_type, alarm_name, host_id, peer_id, ip, details)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        data.alarm_type || 0,
        data.alarm_name || '',
        data.host_id || '',
        data.peer_id || '',
        data.ip || '',
        typeof data.details === 'string' ? data.details : JSON.stringify(data.details || {})
    );
}

/**
 * Query security alarm events
 */
function getAuditAlarms(filters = {}) {
    let sql = 'SELECT * FROM audit_alarms WHERE 1=1';
    const params = [];

    if (filters.alarm_type !== undefined) {
        sql += ' AND alarm_type = ?';
        params.push(filters.alarm_type);
    }
    if (filters.host_id) {
        sql += ' AND host_id = ?';
        params.push(filters.host_id);
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(filters.limit || 100);
    params.push(filters.offset || 0);

    return getAuthDb().prepare(sql).all(...params);
}

/**
 * Count alarm events
 */
function countAuditAlarms(filters = {}) {
    let sql = 'SELECT COUNT(*) as count FROM audit_alarms WHERE 1=1';
    const params = [];

    if (filters.alarm_type !== undefined) {
        sql += ' AND alarm_type = ?';
        params.push(filters.alarm_type);
    }
    if (filters.host_id) {
        sql += ' AND host_id = ?';
        params.push(filters.host_id);
    }

    return getAuthDb().prepare(sql).get(...params).count;
}

// ==================== User Group Operations ====================

/**
 * Get all user groups
 */
function getAllUserGroups() {
    return getAuthDb().prepare('SELECT * FROM user_groups ORDER BY name ASC').all();
}

/**
 * Get user group by GUID
 */
function getUserGroupByGuid(guid) {
    return getAuthDb().prepare('SELECT * FROM user_groups WHERE guid = ?').get(guid);
}

/**
 * Create a user group
 */
function createUserGroup(data) {
    const crypto = require('crypto');
    const guid = data.guid || crypto.randomUUID();
    getAuthDb().prepare(
        'INSERT INTO user_groups (guid, name, note, team_id) VALUES (?, ?, ?, ?)'
    ).run(guid, data.name, data.note || '', data.team_id || '');
    return getAuthDb().prepare('SELECT * FROM user_groups WHERE guid = ?').get(guid);
}

/**
 * Update a user group
 */
function updateUserGroup(guid, data) {
    const sets = [];
    const params = [];

    if (data.name !== undefined) { sets.push('name = ?'); params.push(data.name); }
    if (data.note !== undefined) { sets.push('note = ?'); params.push(data.note); }
    if (data.team_id !== undefined) { sets.push('team_id = ?'); params.push(data.team_id); }

    if (sets.length === 0) return null;

    params.push(guid);
    getAuthDb().prepare(`UPDATE user_groups SET ${sets.join(', ')} WHERE guid = ?`).run(...params);
    return getAuthDb().prepare('SELECT * FROM user_groups WHERE guid = ?').get(guid);
}

/**
 * Delete a user group
 */
function deleteUserGroup(guid) {
    return getAuthDb().prepare('DELETE FROM user_groups WHERE guid = ?').run(guid);
}

// ==================== Device Group Operations ====================

/**
 * Get all device groups with member counts
 */
function getAllDeviceGroups() {
    const groups = getAuthDb().prepare('SELECT * FROM device_groups ORDER BY name ASC').all();
    for (const g of groups) {
        g.member_count = getAuthDb().prepare(
            'SELECT COUNT(*) as c FROM device_group_members WHERE device_group_id = ?'
        ).get(g.id).c;
    }
    return groups;
}

/**
 * Get device group by GUID
 */
function getDeviceGroupByGuid(guid) {
    return getAuthDb().prepare('SELECT * FROM device_groups WHERE guid = ?').get(guid);
}

/**
 * Create a device group
 */
function createDeviceGroup(data) {
    const crypto = require('crypto');
    const guid = data.guid || crypto.randomUUID();
    getAuthDb().prepare(
        'INSERT INTO device_groups (guid, name, note, team_id) VALUES (?, ?, ?, ?)'
    ).run(guid, data.name, data.note || '', data.team_id || '');
    return getAuthDb().prepare('SELECT * FROM device_groups WHERE guid = ?').get(guid);
}

/**
 * Update a device group
 */
function updateDeviceGroup(guid, data) {
    const sets = [];
    const params = [];

    if (data.name !== undefined) { sets.push('name = ?'); params.push(data.name); }
    if (data.note !== undefined) { sets.push('note = ?'); params.push(data.note); }
    if (data.team_id !== undefined) { sets.push('team_id = ?'); params.push(data.team_id); }

    if (sets.length === 0) return null;

    params.push(guid);
    getAuthDb().prepare(`UPDATE device_groups SET ${sets.join(', ')} WHERE guid = ?`).run(...params);
    return getAuthDb().prepare('SELECT * FROM device_groups WHERE guid = ?').get(guid);
}

/**
 * Delete a device group (cascades to memberships)
 */
function deleteDeviceGroup(guid) {
    const group = getAuthDb().prepare('SELECT id FROM device_groups WHERE guid = ?').get(guid);
    if (!group) return { changes: 0 };
    return getAuthDb().prepare('DELETE FROM device_groups WHERE guid = ?').run(guid);
}

/**
 * Add device to group
 */
function addDeviceToGroup(groupGuid, peerId) {
    const group = getAuthDb().prepare('SELECT id FROM device_groups WHERE guid = ?').get(groupGuid);
    if (!group) return null;
    return getAuthDb().prepare(
        'INSERT OR IGNORE INTO device_group_members (device_group_id, peer_id) VALUES (?, ?)'
    ).run(group.id, peerId);
}

/**
 * Remove device from group
 */
function removeDeviceFromGroup(groupGuid, peerId) {
    const group = getAuthDb().prepare('SELECT id FROM device_groups WHERE guid = ?').get(groupGuid);
    if (!group) return null;
    return getAuthDb().prepare(
        'DELETE FROM device_group_members WHERE device_group_id = ? AND peer_id = ?'
    ).run(group.id, peerId);
}

/**
 * Get all members of a device group
 */
function getDeviceGroupMembers(groupGuid) {
    const group = getAuthDb().prepare('SELECT id FROM device_groups WHERE guid = ?').get(groupGuid);
    if (!group) return [];
    return getAuthDb().prepare(
        'SELECT peer_id FROM device_group_members WHERE device_group_id = ?'
    ).all(group.id).map(r => r.peer_id);
}

/**
 * Get device groups for a specific peer
 */
function getDeviceGroupsForPeer(peerId) {
    return getAuthDb().prepare(`
        SELECT dg.* FROM device_groups dg
        INNER JOIN device_group_members dgm ON dg.id = dgm.device_group_id
        WHERE dgm.peer_id = ?
        ORDER BY dg.name ASC
    `).all(peerId);
}

// ==================== Strategy / Policy Operations ====================

/**
 * Get all strategies
 */
function getAllStrategies() {
    const rows = getAuthDb().prepare('SELECT * FROM strategies ORDER BY name ASC').all();
    return rows.map(r => ({
        ...r,
        permissions: safeJsonParse(r.permissions, {})
    }));
}

/**
 * Get strategy by GUID
 */
function getStrategyByGuid(guid) {
    const row = getAuthDb().prepare('SELECT * FROM strategies WHERE guid = ?').get(guid);
    if (!row) return null;
    return { ...row, permissions: safeJsonParse(row.permissions, {}) };
}

/**
 * Create a strategy
 */
function createStrategy(data) {
    const crypto = require('crypto');
    const guid = data.guid || crypto.randomUUID();
    getAuthDb().prepare(`
        INSERT INTO strategies (guid, name, user_group_guid, device_group_guid, enabled, permissions)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        guid,
        data.name,
        data.user_group_guid || '',
        data.device_group_guid || '',
        data.enabled !== undefined ? (data.enabled ? 1 : 0) : 1,
        JSON.stringify(data.permissions || {})
    );
    return getStrategyByGuid(guid);
}

/**
 * Update a strategy
 */
function updateStrategy(guid, data) {
    const sets = [];
    const params = [];

    if (data.name !== undefined) { sets.push('name = ?'); params.push(data.name); }
    if (data.user_group_guid !== undefined) { sets.push('user_group_guid = ?'); params.push(data.user_group_guid); }
    if (data.device_group_guid !== undefined) { sets.push('device_group_guid = ?'); params.push(data.device_group_guid); }
    if (data.enabled !== undefined) { sets.push('enabled = ?'); params.push(data.enabled ? 1 : 0); }
    if (data.permissions !== undefined) { sets.push('permissions = ?'); params.push(JSON.stringify(data.permissions)); }

    if (sets.length === 0) return null;

    sets.push("updated_at = datetime('now')");
    params.push(guid);
    getAuthDb().prepare(`UPDATE strategies SET ${sets.join(', ')} WHERE guid = ?`).run(...params);
    return getStrategyByGuid(guid);
}

/**
 * Delete a strategy
 */
function deleteStrategy(guid) {
    return getAuthDb().prepare('DELETE FROM strategies WHERE guid = ?').run(guid);
}

// ==================== Housekeeping Extensions ====================

/**
 * Run extended housekeeping tasks for RustDesk integration tables
 */
function runIntegrationHousekeeping() {
    const authDb = getAuthDb();

    // Cleanup metrics older than 7 days
    authDb.prepare("DELETE FROM peer_metrics WHERE created_at < datetime('now', '-7 days')").run();

    // Cleanup audit events older than 90 days
    authDb.prepare("DELETE FROM audit_connections WHERE created_at < datetime('now', '-90 days')").run();
    authDb.prepare("DELETE FROM audit_files WHERE created_at < datetime('now', '-90 days')").run();
    authDb.prepare("DELETE FROM audit_alarms WHERE created_at < datetime('now', '-90 days')").run();
}

// ==================== Close connections ====================

function closeAll() {
    if (db) {
        db.close();
        db = null;
    }
    if (authDb) {
        authDb.close();
        authDb = null;
    }
}

module.exports = {
    getDb,
    getAuthDb,
    // Devices
    getAllDevices,
    getDeviceById,
    getDevice: getDeviceById,  // Alias for compatibility
    updateDevice,
    deleteDevice,
    setBanStatus,
    getStats,
    countDevices,
    // Users
    getUserByUsername,
    getUserById,
    createUser,
    updateUserPassword,
    updateLastLogin,
    hasUsers,
    getAllUsers,
    updateUserRole,
    deleteUser,
    countAdmins,
    // TOTP
    saveTotpSecret,
    enableTotp,
    disableTotp,
    useRecoveryCode,
    resetAdminPassword,
    deleteAllUsers,
    // Folders
    getAllFolders,
    getFolderById,
    createFolder,
    updateFolder,
    deleteFolder,
    assignDeviceToFolder,
    assignDevicesToFolder,
    unassignDevicesFromFolder,
    getUnassignedDeviceCount,
    getAllFolderAssignments,
    // Audit
    logAction,
    getAuditLogs,
    // Access tokens (RustDesk client API)
    createAccessToken,
    getAccessToken,
    touchAccessToken,
    revokeAccessToken,
    revokeUserClientTokens,
    revokeAllUserTokens,
    cleanupExpiredTokens,
    // Login attempt tracking
    recordLoginAttempt,
    countRecentFailedAttempts,
    countRecentFailedAttemptsFromIp,
    lockAccount,
    getAccountLockout,
    clearAccountLockout,
    cleanupOldLoginAttempts,
    // Address books
    getAddressBook,
    saveAddressBook,
    getAddressBookTags,
    // Console settings
    getSetting,
    setSetting,
    getAllSettings,
    // Pending Registrations (LAN Discovery)
    getPendingRegistrations,
    getPendingRegistrationById,
    getPendingRegistrationByDeviceId,
    createPendingRegistration,
    approvePendingRegistration,
    rejectPendingRegistration,
    deletePendingRegistration,
    getPendingRegistrationCount,
    // Peer Sysinfo (RustDesk client integration)
    upsertPeerSysinfo,
    getPeerSysinfo,
    getAllPeerSysinfo,
    // Peer Metrics (heartbeat telemetry)
    updatePeerOnlineStatus,
    cleanupStaleOnlinePeers,
    insertPeerMetric,
    getPeerMetrics,
    getLatestPeerMetric,
    cleanupOldMetrics,
    // Audit: connections
    insertAuditConnection,
    getAuditConnections,
    countAuditConnections,
    // Audit: file transfers
    insertAuditFile,
    getAuditFiles,
    countAuditFiles,
    // Audit: security alarms
    insertAuditAlarm,
    getAuditAlarms,
    countAuditAlarms,
    // User groups
    getAllUserGroups,
    getUserGroupByGuid,
    createUserGroup,
    updateUserGroup,
    deleteUserGroup,
    // Device groups
    getAllDeviceGroups,
    getDeviceGroupByGuid,
    createDeviceGroup,
    updateDeviceGroup,
    deleteDeviceGroup,
    addDeviceToGroup,
    removeDeviceFromGroup,
    getDeviceGroupMembers,
    getDeviceGroupsForPeer,
    // Strategies / policies
    getAllStrategies,
    getStrategyByGuid,
    createStrategy,
    updateStrategy,
    deleteStrategy,
    // Housekeeping extensions
    runIntegrationHousekeeping,
    // Cleanup
    closeAll
};
