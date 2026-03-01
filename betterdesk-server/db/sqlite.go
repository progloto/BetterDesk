package db

import (
	"database/sql"
	"fmt"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// SQLiteDB implements the Database interface using modernc.org/sqlite (pure Go, no CGO).
type SQLiteDB struct {
	db *sql.DB
	mu sync.RWMutex // serialize writes (SQLite limitation)
}

// OpenSQLite opens or creates a SQLite database at the given path.
func OpenSQLite(path string) (*SQLiteDB, error) {
	dsn := fmt.Sprintf("file:%s?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=ON", path)
	sqlDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("db: failed to open SQLite %q: %w", path, err)
	}
	sqlDB.SetMaxOpenConns(1) // SQLite single-writer
	sqlDB.SetMaxIdleConns(1)
	sqlDB.SetConnMaxLifetime(0) // keep alive

	if err := sqlDB.Ping(); err != nil {
		return nil, fmt.Errorf("db: SQLite ping failed: %w", err)
	}

	return &SQLiteDB{db: sqlDB}, nil
}

// Close closes the database connection.
func (s *SQLiteDB) Close() error {
	return s.db.Close()
}

// Migrate creates all required tables if they don't exist.
func (s *SQLiteDB) Migrate() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	statements := []string{
		`CREATE TABLE IF NOT EXISTS peers (
			id TEXT PRIMARY KEY,
			uuid TEXT DEFAULT '',
			pk BLOB DEFAULT NULL,
			ip TEXT DEFAULT '',
			user TEXT DEFAULT '',
			hostname TEXT DEFAULT '',
			os TEXT DEFAULT '',
			version TEXT DEFAULT '',
			status TEXT DEFAULT 'OFFLINE',
			nat_type INTEGER DEFAULT 0,
			last_online TEXT DEFAULT '',
			created_at TEXT DEFAULT (datetime('now')),
			disabled INTEGER DEFAULT 0,
			banned INTEGER DEFAULT 0,
			ban_reason TEXT DEFAULT '',
			banned_at TEXT DEFAULT NULL,
			soft_deleted INTEGER DEFAULT 0,
			deleted_at TEXT DEFAULT NULL,
			note TEXT DEFAULT '',
			tags TEXT DEFAULT '',
			heartbeat_seq INTEGER DEFAULT 0
		)`,
		`CREATE INDEX IF NOT EXISTS idx_peers_uuid ON peers(uuid)`,
		`CREATE INDEX IF NOT EXISTS idx_peers_status ON peers(status)`,
		`CREATE INDEX IF NOT EXISTS idx_peers_banned ON peers(banned)`,

		`CREATE TABLE IF NOT EXISTS server_config (
			key TEXT PRIMARY KEY,
			value TEXT DEFAULT ''
		)`,

		`CREATE TABLE IF NOT EXISTS id_change_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			old_id TEXT NOT NULL,
			new_id TEXT NOT NULL,
			changed_at TEXT DEFAULT (datetime('now')),
			reason TEXT DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS idx_id_history_old ON id_change_history(old_id)`,
		`CREATE INDEX IF NOT EXISTS idx_id_history_new ON id_change_history(new_id)`,

		// Users table (authentication)
		`CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			username TEXT UNIQUE NOT NULL,
			password_hash TEXT NOT NULL,
			role TEXT NOT NULL DEFAULT 'viewer',
			totp_secret TEXT DEFAULT '',
			totp_enabled INTEGER DEFAULT 0,
			created_at TEXT DEFAULT (datetime('now')),
			last_login TEXT DEFAULT ''
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)`,

		// API keys table (scoped programmatic access)
		`CREATE TABLE IF NOT EXISTS api_keys (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			key_hash TEXT UNIQUE NOT NULL,
			key_prefix TEXT NOT NULL DEFAULT '',
			name TEXT NOT NULL DEFAULT '',
			role TEXT NOT NULL DEFAULT 'viewer',
			created_at TEXT DEFAULT (datetime('now')),
			expires_at TEXT DEFAULT '',
			last_used TEXT DEFAULT ''
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)`,

		// Device tokens table (Dual Key System for enhanced security)
		`CREATE TABLE IF NOT EXISTS device_tokens (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			token_hash TEXT UNIQUE NOT NULL,
			token_prefix TEXT NOT NULL DEFAULT '',
			name TEXT NOT NULL DEFAULT '',
			peer_id TEXT DEFAULT '',
			status TEXT NOT NULL DEFAULT 'pending',
			max_uses INTEGER DEFAULT 1,
			use_count INTEGER DEFAULT 0,
			created_at TEXT DEFAULT (datetime('now')),
			expires_at TEXT DEFAULT NULL,
			revoked_at TEXT DEFAULT NULL,
			last_used_at TEXT DEFAULT NULL,
			created_by TEXT DEFAULT '',
			note TEXT DEFAULT ''
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_device_tokens_hash ON device_tokens(token_hash)`,
		`CREATE INDEX IF NOT EXISTS idx_device_tokens_peer ON device_tokens(peer_id)`,
		`CREATE INDEX IF NOT EXISTS idx_device_tokens_status ON device_tokens(status)`,
	}

	for _, stmt := range statements {
		if _, err := s.db.Exec(stmt); err != nil {
			return fmt.Errorf("db: migration failed: %w\nStatement: %s", err, stmt)
		}
	}
	return nil
}

// GetPeer returns a peer by ID, or nil if not found.
func (s *SQLiteDB) GetPeer(id string) (*Peer, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	p := &Peer{}
	var lastOnline, createdAt, bannedAt, deletedAt sql.NullString

	err := s.db.QueryRow(`
		SELECT id, uuid, pk, ip, user, hostname, os, version, 
		       status, nat_type, last_online, created_at,
		       disabled, banned, ban_reason, banned_at,
		       soft_deleted, deleted_at, note, tags, heartbeat_seq
		FROM peers WHERE id = ?`, id).Scan(
		&p.ID, &p.UUID, &p.PK, &p.IP, &p.User, &p.Hostname,
		&p.OS, &p.Version, &p.Status, &p.NATType,
		&lastOnline, &createdAt, &p.Disabled, &p.Banned,
		&p.BanReason, &bannedAt, &p.SoftDeleted, &deletedAt,
		&p.Note, &p.Tags, &p.HeartbeatSeq,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("db: GetPeer(%q): %w", id, err)
	}

	p.LastOnline = parseTime(lastOnline)
	p.CreatedAt = parseTime(createdAt)
	p.BannedAt = parseTimePtr(bannedAt)
	p.DeletedAt = parseTimePtr(deletedAt)

	return p, nil
}

// GetPeerByUUID returns a peer by UUID, or nil if not found.
func (s *SQLiteDB) GetPeerByUUID(uuid string) (*Peer, error) {
	s.mu.RLock()
	var id string
	err := s.db.QueryRow(`SELECT id FROM peers WHERE uuid = ?`, uuid).Scan(&id)
	s.mu.RUnlock()

	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	return s.GetPeer(id)
}

// UpsertPeer inserts or updates a peer record.
func (s *SQLiteDB) UpsertPeer(p *Peer) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(`
		INSERT INTO peers (id, uuid, pk, ip, user, hostname, os, version, 
		                    status, nat_type, last_online, disabled, note, tags, heartbeat_seq)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			uuid = COALESCE(NULLIF(excluded.uuid, ''), peers.uuid),
			pk = COALESCE(excluded.pk, peers.pk),
			ip = excluded.ip,
			user = COALESCE(NULLIF(excluded.user, ''), peers.user),
			hostname = COALESCE(NULLIF(excluded.hostname, ''), peers.hostname),
			os = COALESCE(NULLIF(excluded.os, ''), peers.os),
			version = COALESCE(NULLIF(excluded.version, ''), peers.version),
			status = excluded.status,
			nat_type = excluded.nat_type,
			last_online = excluded.last_online,
			disabled = excluded.disabled,
			note = COALESCE(NULLIF(excluded.note, ''), peers.note),
			tags = COALESCE(NULLIF(excluded.tags, ''), peers.tags),
			heartbeat_seq = excluded.heartbeat_seq`,
		p.ID, p.UUID, p.PK, p.IP, p.User, p.Hostname, p.OS, p.Version,
		p.Status, p.NATType, formatTime(p.LastOnline),
		p.Disabled, p.Note, p.Tags, p.HeartbeatSeq,
	)
	if err != nil {
		return fmt.Errorf("db: UpsertPeer(%q): %w", p.ID, err)
	}
	return nil
}

// DeletePeer marks a peer as soft-deleted.
func (s *SQLiteDB) DeletePeer(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`UPDATE peers SET soft_deleted = 1, deleted_at = datetime('now') WHERE id = ?`, id)
	return err
}

// HardDeletePeer permanently removes a peer from the database.
func (s *SQLiteDB) HardDeletePeer(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(`DELETE FROM peers WHERE id = ?`, id)
	return err
}

// ListPeers returns all peers, optionally including soft-deleted ones.
func (s *SQLiteDB) ListPeers(includeDeleted bool) ([]*Peer, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	query := `SELECT id, uuid, pk, ip, user, hostname, os, version,
	                  status, nat_type, last_online, created_at,
	                  disabled, banned, ban_reason, banned_at,
	                  soft_deleted, deleted_at, note, tags, heartbeat_seq
	           FROM peers`
	if !includeDeleted {
		query += ` WHERE soft_deleted = 0`
	}
	query += ` ORDER BY id`

	rows, err := s.db.Query(query)
	if err != nil {
		return nil, fmt.Errorf("db: ListPeers: %w", err)
	}
	defer rows.Close()

	var peers []*Peer
	for rows.Next() {
		p := &Peer{}
		var lastOnline, createdAt, bannedAt, deletedAt sql.NullString
		if err := rows.Scan(
			&p.ID, &p.UUID, &p.PK, &p.IP, &p.User, &p.Hostname,
			&p.OS, &p.Version, &p.Status, &p.NATType,
			&lastOnline, &createdAt, &p.Disabled, &p.Banned,
			&p.BanReason, &bannedAt, &p.SoftDeleted, &deletedAt,
			&p.Note, &p.Tags, &p.HeartbeatSeq,
		); err != nil {
			return nil, fmt.Errorf("db: ListPeers scan: %w", err)
		}
		p.LastOnline = parseTime(lastOnline)
		p.CreatedAt = parseTime(createdAt)
		p.BannedAt = parseTimePtr(bannedAt)
		p.DeletedAt = parseTimePtr(deletedAt)
		peers = append(peers, p)
	}
	return peers, rows.Err()
}

// GetPeerCount returns total and online peer counts.
func (s *SQLiteDB) GetPeerCount() (total int, online int, err error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	err = s.db.QueryRow(
		`SELECT COUNT(*) FROM peers WHERE soft_deleted = 0`).Scan(&total)
	if err != nil {
		return 0, 0, err
	}
	err = s.db.QueryRow(
		`SELECT COUNT(*) FROM peers WHERE soft_deleted = 0 AND status = 'ONLINE'`).Scan(&online)
	return total, online, err
}

// UpdatePeerStatus updates a peer's status and IP, plus last_online timestamp.
func (s *SQLiteDB) UpdatePeerStatus(id string, status string, ip string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`UPDATE peers SET status = ?, ip = ?, last_online = datetime('now') WHERE id = ?`,
		status, ip, id)
	return err
}

// SetAllOffline marks all peers as OFFLINE. Called at server startup.
func (s *SQLiteDB) SetAllOffline() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(`UPDATE peers SET status = 'OFFLINE'`)
	return err
}

// BanPeer bans a specific peer by ID.
func (s *SQLiteDB) BanPeer(id string, reason string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`UPDATE peers SET banned = 1, ban_reason = ?, banned_at = datetime('now') WHERE id = ?`,
		reason, id)
	return err
}

// UnbanPeer removes the ban from a peer.
func (s *SQLiteDB) UnbanPeer(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`UPDATE peers SET banned = 0, ban_reason = '', banned_at = NULL WHERE id = ?`, id)
	return err
}

// IsPeerBanned checks if a peer is banned.
func (s *SQLiteDB) IsPeerBanned(id string) (bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var banned bool
	err := s.db.QueryRow(`SELECT banned FROM peers WHERE id = ?`, id).Scan(&banned)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return banned, err
}

// ChangePeerID changes a peer's ID and records it in history.
func (s *SQLiteDB) ChangePeerID(oldID, newID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Check new ID doesn't exist
	var count int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM peers WHERE id = ?`, newID).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return fmt.Errorf("db: peer ID %q already exists", newID)
	}

	// Create new row with new ID, copy data from old
	_, err = tx.Exec(`
		INSERT INTO peers (id, uuid, pk, ip, user, hostname, os, version,
		                    status, nat_type, last_online, created_at,
		                    disabled, banned, ban_reason, banned_at,
		                    soft_deleted, deleted_at, note, tags, heartbeat_seq)
		SELECT ?, uuid, pk, ip, user, hostname, os, version,
		       status, nat_type, last_online, created_at,
		       disabled, banned, ban_reason, banned_at,
		       soft_deleted, deleted_at, note, tags, heartbeat_seq
		FROM peers WHERE id = ?`, newID, oldID)
	if err != nil {
		return fmt.Errorf("db: ChangePeerID insert: %w", err)
	}

	// Delete old row
	if _, err := tx.Exec(`DELETE FROM peers WHERE id = ?`, oldID); err != nil {
		return fmt.Errorf("db: ChangePeerID delete: %w", err)
	}

	// Record in history
	if _, err := tx.Exec(
		`INSERT INTO id_change_history (old_id, new_id) VALUES (?, ?)`,
		oldID, newID); err != nil {
		return fmt.Errorf("db: ChangePeerID history: %w", err)
	}

	return tx.Commit()
}

// GetIDChangeHistory returns the ID change history for a peer.
func (s *SQLiteDB) GetIDChangeHistory(id string) ([]*IDChangeHistory, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	rows, err := s.db.Query(
		`SELECT old_id, new_id, changed_at, reason FROM id_change_history
		 WHERE old_id = ? OR new_id = ? ORDER BY changed_at DESC`, id, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var history []*IDChangeHistory
	for rows.Next() {
		h := &IDChangeHistory{}
		var changedAt string
		if err := rows.Scan(&h.OldID, &h.NewID, &changedAt, &h.Reason); err != nil {
			return nil, err
		}
		h.ChangedAt, _ = time.Parse("2006-01-02 15:04:05", changedAt)
		history = append(history, h)
	}
	return history, rows.Err()
}

// GetConfig retrieves a configuration value by key.
func (s *SQLiteDB) GetConfig(key string) (string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var value string
	err := s.db.QueryRow(`SELECT value FROM server_config WHERE key = ?`, key).Scan(&value)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return value, err
}

// SetConfig sets a configuration key-value pair.
func (s *SQLiteDB) SetConfig(key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`INSERT INTO server_config (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

// DeleteConfig removes a configuration key.
func (s *SQLiteDB) DeleteConfig(key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(`DELETE FROM server_config WHERE key = ?`, key)
	return err
}

// UpdatePeerTags updates the tags field for a peer.
func (s *SQLiteDB) UpdatePeerTags(id, tags string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	res, err := s.db.Exec(`UPDATE peers SET tags = ? WHERE id = ?`, tags, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("peer %s not found", id)
	}
	return nil
}

// ListPeersByTag returns all non-deleted peers that have the given tag.
// Tags are stored as comma-separated strings; the query uses LIKE matching.
func (s *SQLiteDB) ListPeersByTag(tag string) ([]*Peer, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	// M1: Escape SQL LIKE wildcards to prevent pattern injection.
	// '%' and '_' in user-supplied tag could match unintended rows.
	escaped := strings.NewReplacer("%", "\\%", "_", "\\_").Replace(tag)
	pattern := "%" + escaped + "%"
	rows, err := s.db.Query(`
		SELECT id, uuid, pk, ip, user, hostname, os, version, status, nat_type,
		       last_online, created_at, disabled, banned, ban_reason, banned_at,
		       soft_deleted, deleted_at, note, tags, heartbeat_seq
		FROM peers
		WHERE soft_deleted = 0 AND tags LIKE ? ESCAPE '\'
		ORDER BY id`, pattern)
	if err != nil {
		return nil, fmt.Errorf("db: ListPeersByTag: %w", err)
	}
	defer rows.Close()

	var peers []*Peer
	for rows.Next() {
		p := &Peer{}
		var lastOnline, createdAt, bannedAt, deletedAt sql.NullString
		if err := rows.Scan(
			&p.ID, &p.UUID, &p.PK, &p.IP, &p.User, &p.Hostname,
			&p.OS, &p.Version, &p.Status, &p.NATType,
			&lastOnline, &createdAt, &p.Disabled, &p.Banned,
			&p.BanReason, &bannedAt, &p.SoftDeleted, &deletedAt,
			&p.Note, &p.Tags, &p.HeartbeatSeq,
		); err != nil {
			return nil, fmt.Errorf("db: ListPeersByTag scan: %w", err)
		}
		p.LastOnline = parseTime(lastOnline)
		p.CreatedAt = parseTime(createdAt)
		p.BannedAt = parseTimePtr(bannedAt)
		p.DeletedAt = parseTimePtr(deletedAt)
		peers = append(peers, p)
	}
	return peers, rows.Err()
}

// Helper: parse SQLite datetime to time.Time
func parseTime(ns sql.NullString) time.Time {
	if !ns.Valid || ns.String == "" {
		return time.Time{}
	}
	t, _ := time.Parse("2006-01-02 15:04:05", ns.String)
	return t
}

func parseTimePtr(ns sql.NullString) *time.Time {
	if !ns.Valid || ns.String == "" {
		return nil
	}
	t, _ := time.Parse("2006-01-02 15:04:05", ns.String)
	return &t
}

func formatTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format("2006-01-02 15:04:05")
}

// --- User Operations ---

// CreateUser inserts a new user.
func (s *SQLiteDB) CreateUser(u *User) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(`INSERT INTO users (username, password_hash, role, totp_secret, totp_enabled)
		VALUES (?, ?, ?, ?, ?)`,
		u.Username, u.PasswordHash, u.Role, u.TOTPSecret, u.TOTPEnabled)
	if err != nil {
		return fmt.Errorf("db: CreateUser: %w", err)
	}
	u.ID, _ = res.LastInsertId()
	return nil
}

// GetUser returns a user by username, or nil if not found.
func (s *SQLiteDB) GetUser(username string) (*User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	u := &User{}
	err := s.db.QueryRow(`SELECT id, username, password_hash, role, totp_secret, totp_enabled,
		created_at, last_login FROM users WHERE username = ?`, username).Scan(
		&u.ID, &u.Username, &u.PasswordHash, &u.Role,
		&u.TOTPSecret, &u.TOTPEnabled, &u.CreatedAt, &u.LastLogin)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return u, err
}

// GetUserByID returns a user by numeric ID, or nil if not found.
func (s *SQLiteDB) GetUserByID(id int64) (*User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	u := &User{}
	err := s.db.QueryRow(`SELECT id, username, password_hash, role, totp_secret, totp_enabled,
		created_at, last_login FROM users WHERE id = ?`, id).Scan(
		&u.ID, &u.Username, &u.PasswordHash, &u.Role,
		&u.TOTPSecret, &u.TOTPEnabled, &u.CreatedAt, &u.LastLogin)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return u, err
}

// ListUsers returns all users.
func (s *SQLiteDB) ListUsers() ([]*User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rows, err := s.db.Query(`SELECT id, username, password_hash, role, totp_secret, totp_enabled,
		created_at, last_login FROM users ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("db: ListUsers: %w", err)
	}
	defer rows.Close()
	var users []*User
	for rows.Next() {
		u := &User{}
		if err := rows.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.Role,
			&u.TOTPSecret, &u.TOTPEnabled, &u.CreatedAt, &u.LastLogin); err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

// UpdateUser updates a user's mutable fields.
func (s *SQLiteDB) UpdateUser(u *User) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`UPDATE users SET password_hash=?, role=?, totp_secret=?, totp_enabled=?
		WHERE id=?`, u.PasswordHash, u.Role, u.TOTPSecret, u.TOTPEnabled, u.ID)
	return err
}

// DeleteUser removes a user by ID.
func (s *SQLiteDB) DeleteUser(id int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`DELETE FROM users WHERE id=?`, id)
	return err
}

// UpdateUserLogin updates the last_login timestamp for a user.
func (s *SQLiteDB) UpdateUserLogin(id int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`UPDATE users SET last_login=datetime('now') WHERE id=?`, id)
	return err
}

// UserCount returns the total number of users.
func (s *SQLiteDB) UserCount() (int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&count)
	return count, err
}

// --- API Key Operations ---

// CreateAPIKey inserts a new API key.
func (s *SQLiteDB) CreateAPIKey(k *APIKey) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(`INSERT INTO api_keys (key_hash, key_prefix, name, role, expires_at)
		VALUES (?, ?, ?, ?, ?)`,
		k.KeyHash, k.KeyPrefix, k.Name, k.Role, k.ExpiresAt)
	if err != nil {
		return fmt.Errorf("db: CreateAPIKey: %w", err)
	}
	k.ID, _ = res.LastInsertId()
	return nil
}

// GetAPIKeyByHash returns an API key by its SHA-256 hash, or nil if not found.
func (s *SQLiteDB) GetAPIKeyByHash(keyHash string) (*APIKey, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	k := &APIKey{}
	err := s.db.QueryRow(`SELECT id, key_hash, key_prefix, name, role, created_at, expires_at, last_used
		FROM api_keys WHERE key_hash = ?`, keyHash).Scan(
		&k.ID, &k.KeyHash, &k.KeyPrefix, &k.Name, &k.Role,
		&k.CreatedAt, &k.ExpiresAt, &k.LastUsed)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return k, err
}

// ListAPIKeys returns all API keys.
func (s *SQLiteDB) ListAPIKeys() ([]*APIKey, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rows, err := s.db.Query(`SELECT id, key_hash, key_prefix, name, role, created_at, expires_at, last_used
		FROM api_keys ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("db: ListAPIKeys: %w", err)
	}
	defer rows.Close()
	var keys []*APIKey
	for rows.Next() {
		k := &APIKey{}
		if err := rows.Scan(&k.ID, &k.KeyHash, &k.KeyPrefix, &k.Name, &k.Role,
			&k.CreatedAt, &k.ExpiresAt, &k.LastUsed); err != nil {
			return nil, err
		}
		keys = append(keys, k)
	}
	return keys, rows.Err()
}

// DeleteAPIKey removes an API key by ID.
func (s *SQLiteDB) DeleteAPIKey(id int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`DELETE FROM api_keys WHERE id=?`, id)
	return err
}

// TouchAPIKey updates the last_used timestamp for an API key.
func (s *SQLiteDB) TouchAPIKey(id int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`UPDATE api_keys SET last_used=datetime('now') WHERE id=?`, id)
	return err
}

// ============================================================================
// Device Token Methods (Dual Key System)
// ============================================================================

// CreateDeviceToken creates a new device enrollment token.
func (s *SQLiteDB) CreateDeviceToken(t *DeviceToken) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	var expiresAt sql.NullString
	if t.ExpiresAt != nil {
		expiresAt.Valid = true
		expiresAt.String = t.ExpiresAt.Format(time.RFC3339)
	}

	res, err := s.db.Exec(`
		INSERT INTO device_tokens (token_hash, token_prefix, name, peer_id, status, max_uses, use_count, expires_at, created_by, note)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		t.TokenHash, t.Token[:8], t.Name, t.PeerID, t.Status, t.MaxUses, t.UseCount, expiresAt, t.CreatedBy, t.Note)
	if err != nil {
		return fmt.Errorf("db: CreateDeviceToken: %w", err)
	}
	id, _ := res.LastInsertId()
	t.ID = id
	return nil
}

// GetDeviceToken returns a device token by ID.
func (s *SQLiteDB) GetDeviceToken(id int64) (*DeviceToken, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.getDeviceTokenByQuery(`SELECT id, token_hash, token_prefix, name, peer_id, status, max_uses, use_count, 
		created_at, expires_at, revoked_at, last_used_at, created_by, note 
		FROM device_tokens WHERE id = ?`, id)
}

// GetDeviceTokenByHash returns a device token by its hash.
func (s *SQLiteDB) GetDeviceTokenByHash(tokenHash string) (*DeviceToken, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.getDeviceTokenByQuery(`SELECT id, token_hash, token_prefix, name, peer_id, status, max_uses, use_count, 
		created_at, expires_at, revoked_at, last_used_at, created_by, note 
		FROM device_tokens WHERE token_hash = ?`, tokenHash)
}

// GetDeviceTokenByPeerID returns the token bound to a peer.
func (s *SQLiteDB) GetDeviceTokenByPeerID(peerID string) (*DeviceToken, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.getDeviceTokenByQuery(`SELECT id, token_hash, token_prefix, name, peer_id, status, max_uses, use_count, 
		created_at, expires_at, revoked_at, last_used_at, created_by, note 
		FROM device_tokens WHERE peer_id = ? AND status = 'active'`, peerID)
}

// getDeviceTokenByQuery is a helper function to scan a device token row.
func (s *SQLiteDB) getDeviceTokenByQuery(query string, args ...interface{}) (*DeviceToken, error) {
	t := &DeviceToken{}
	var createdAt, expiresAt, revokedAt, lastUsedAt sql.NullString

	err := s.db.QueryRow(query, args...).Scan(
		&t.ID, &t.TokenHash, &t.Token, &t.Name, &t.PeerID, &t.Status, &t.MaxUses, &t.UseCount,
		&createdAt, &expiresAt, &revokedAt, &lastUsedAt, &t.CreatedBy, &t.Note)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	if createdAt.Valid {
		if tm, err := time.Parse(time.RFC3339, createdAt.String); err == nil {
			t.CreatedAt = tm
		} else if tm, err := time.Parse("2006-01-02 15:04:05", createdAt.String); err == nil {
			t.CreatedAt = tm
		}
	}
	if expiresAt.Valid {
		if tm, err := time.Parse(time.RFC3339, expiresAt.String); err == nil {
			t.ExpiresAt = &tm
		} else if tm, err := time.Parse("2006-01-02 15:04:05", expiresAt.String); err == nil {
			t.ExpiresAt = &tm
		}
	}
	if revokedAt.Valid {
		if tm, err := time.Parse(time.RFC3339, revokedAt.String); err == nil {
			t.RevokedAt = &tm
		} else if tm, err := time.Parse("2006-01-02 15:04:05", revokedAt.String); err == nil {
			t.RevokedAt = &tm
		}
	}
	if lastUsedAt.Valid {
		if tm, err := time.Parse(time.RFC3339, lastUsedAt.String); err == nil {
			t.LastUsedAt = &tm
		} else if tm, err := time.Parse("2006-01-02 15:04:05", lastUsedAt.String); err == nil {
			t.LastUsedAt = &tm
		}
	}
	return t, nil
}

// ListDeviceTokens returns all device tokens.
func (s *SQLiteDB) ListDeviceTokens(includeRevoked bool) ([]*DeviceToken, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	query := `SELECT id, token_hash, token_prefix, name, peer_id, status, max_uses, use_count, 
		created_at, expires_at, revoked_at, last_used_at, created_by, note 
		FROM device_tokens`
	if !includeRevoked {
		query += ` WHERE status != 'revoked'`
	}
	query += ` ORDER BY id DESC`

	rows, err := s.db.Query(query)
	if err != nil {
		return nil, fmt.Errorf("db: ListDeviceTokens: %w", err)
	}
	defer rows.Close()

	var tokens []*DeviceToken
	for rows.Next() {
		t := &DeviceToken{}
		var createdAt, expiresAt, revokedAt, lastUsedAt sql.NullString

		if err := rows.Scan(&t.ID, &t.TokenHash, &t.Token, &t.Name, &t.PeerID, &t.Status,
			&t.MaxUses, &t.UseCount, &createdAt, &expiresAt, &revokedAt, &lastUsedAt,
			&t.CreatedBy, &t.Note); err != nil {
			return nil, err
		}

		if createdAt.Valid {
			if tm, err := time.Parse(time.RFC3339, createdAt.String); err == nil {
				t.CreatedAt = tm
			} else if tm, err := time.Parse("2006-01-02 15:04:05", createdAt.String); err == nil {
				t.CreatedAt = tm
			}
		}
		if expiresAt.Valid {
			if tm, err := time.Parse(time.RFC3339, expiresAt.String); err == nil {
				t.ExpiresAt = &tm
			}
		}
		if revokedAt.Valid {
			if tm, err := time.Parse(time.RFC3339, revokedAt.String); err == nil {
				t.RevokedAt = &tm
			}
		}
		if lastUsedAt.Valid {
			if tm, err := time.Parse(time.RFC3339, lastUsedAt.String); err == nil {
				t.LastUsedAt = &tm
			}
		}
		tokens = append(tokens, t)
	}
	return tokens, rows.Err()
}

// UpdateDeviceToken updates a device token.
func (s *SQLiteDB) UpdateDeviceToken(t *DeviceToken) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	var expiresAt sql.NullString
	if t.ExpiresAt != nil {
		expiresAt.Valid = true
		expiresAt.String = t.ExpiresAt.Format(time.RFC3339)
	}

	_, err := s.db.Exec(`
		UPDATE device_tokens SET name=?, peer_id=?, status=?, max_uses=?, expires_at=?, note=?
		WHERE id=?`, t.Name, t.PeerID, t.Status, t.MaxUses, expiresAt, t.Note, t.ID)
	return err
}

// RevokeDeviceToken revokes a device token by ID.
func (s *SQLiteDB) RevokeDeviceToken(id int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`UPDATE device_tokens SET status='revoked', revoked_at=datetime('now') WHERE id=?`, id)
	return err
}

// BindTokenToPeer binds a token to a peer ID after successful enrollment.
func (s *SQLiteDB) BindTokenToPeer(tokenHash, peerID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`
		UPDATE device_tokens SET peer_id=?, status='active', last_used_at=datetime('now')
		WHERE token_hash=? AND status='pending'`, peerID, tokenHash)
	return err
}

// IncrementTokenUse increments the use count for a token.
func (s *SQLiteDB) IncrementTokenUse(tokenHash string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`
		UPDATE device_tokens SET use_count = use_count + 1, last_used_at=datetime('now')
		WHERE token_hash=?`, tokenHash)
	return err
}

// ValidateToken checks if a token is valid for enrollment.
// Returns the token if valid, nil if invalid/expired/revoked.
func (s *SQLiteDB) ValidateToken(tokenHash string) (*DeviceToken, error) {
	t, err := s.GetDeviceTokenByHash(tokenHash)
	if err != nil {
		return nil, err
	}
	if t == nil {
		return nil, nil // Token not found
	}

	// Check status
	if t.Status == TokenStatusRevoked {
		return nil, nil
	}

	// Check expiration
	if t.ExpiresAt != nil && time.Now().After(*t.ExpiresAt) {
		// Mark as expired if not already
		s.mu.Lock()
		s.db.Exec(`UPDATE device_tokens SET status='expired' WHERE id=? AND status NOT IN ('revoked', 'expired')`, t.ID)
		s.mu.Unlock()
		return nil, nil
	}

	// Check max uses
	if t.MaxUses > 0 && t.UseCount >= t.MaxUses {
		return nil, nil // Exceeded max uses
	}

	return t, nil
}

// CleanupExpiredTokens marks expired tokens as expired.
func (s *SQLiteDB) CleanupExpiredTokens() (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(`
		UPDATE device_tokens SET status='expired' 
		WHERE status='pending' AND expires_at IS NOT NULL AND expires_at < datetime('now')`)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
