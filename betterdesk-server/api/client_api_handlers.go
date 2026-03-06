// RustDesk Client API handlers.
// Provides RustDesk-compatible endpoints on the Go server's API port (:21114).
// The RustDesk desktop client calculates API port as signal_port - 2 (21116-2=21114),
// so these endpoints must be served on the same port as the admin API.
//
// Endpoints:
//   POST /api/login          — RustDesk-compatible login (username/password + TOTP)
//   GET  /api/login-options   — Available authentication methods
//   POST /api/logout          — Invalidate session (no-op for stateless JWT)
//   GET  /api/currentUser     — Get current user info (Bearer token required)
//   POST /api/ab              — Get/update address book
//   GET  /api/ab              — Get address book
package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/unitronix/betterdesk-server/audit"
	"github.com/unitronix/betterdesk-server/auth"
)

// tfaSession holds temporary state for a two-factor auth flow in progress.
type tfaSession struct {
	username  string
	role      string
	userID    int64
	clientID  string
	clientIP  string
	createdAt time.Time
}

// tfaSessionStore is a concurrency-safe in-memory store for pending 2FA sessions.
// Sessions expire after 5 minutes.
type tfaSessionStore struct {
	mu       sync.Mutex
	sessions map[string]*tfaSession
}

func newTFASessionStore() *tfaSessionStore {
	return &tfaSessionStore{sessions: make(map[string]*tfaSession)}
}

func (s *tfaSessionStore) put(secret string, sess *tfaSession) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Prune expired sessions (>5 min)
	now := time.Now()
	for k, v := range s.sessions {
		if now.Sub(v.createdAt) > 5*time.Minute {
			delete(s.sessions, k)
		}
	}
	// Limit total sessions to prevent memory exhaustion
	if len(s.sessions) >= 1000 {
		s.mu.Unlock()
		return
	}
	s.sessions[secret] = sess
}

func (s *tfaSessionStore) take(secret string) *tfaSession {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[secret]
	if !ok {
		return nil
	}
	delete(s.sessions, secret)
	if time.Since(sess.createdAt) > 5*time.Minute {
		return nil // expired
	}
	return sess
}

// rustdeskUserPayload builds a user object in the format the RustDesk client expects.
func rustdeskUserPayload(username, role string) map[string]any {
	return map[string]any{
		"name":     username,
		"email":    "",
		"note":     "",
		"status":   1, // kNormal
		"is_admin": role == auth.RoleAdmin,
	}
}

// handleClientLogin processes RustDesk desktop client login requests.
// POST /api/login
//
// Request body (initial login):
//
//	{ "username": "...", "password": "...", "id": "DEVICE_ID", "uuid": "...", "type": "account" }
//
// Request body (2FA verification):
//
//	{ "verificationCode": "123456", "secret": "hex...", "id": "DEVICE_ID", "uuid": "..." }
//
// Response (success):
//
//	{ "type": "access_token", "access_token": "jwt...", "user": { "name": ..., "is_admin": ... } }
//
// Response (2FA required):
//
//	{ "type": "tfa_check", "tfa_type": "totp", "secret": "hex..." }
func (s *Server) handleClientLogin(w http.ResponseWriter, r *http.Request) {
	clientIP := s.remoteIP(r)

	// Rate limiting
	if s.loginLimiter != nil && !s.loginLimiter.Allow(clientIP) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{
			"error": "Too many login attempts. Please try again later.",
		})
		return
	}

	var body struct {
		Username         string `json:"username"`
		Password         string `json:"password"`
		ID               string `json:"id"`   // RustDesk device ID
		UUID             string `json:"uuid"` // RustDesk device UUID
		Type             string `json:"type"` // "account" or "email_code"
		VerificationCode string `json:"verificationCode"`
		TfaCode          string `json:"tfaCode"`
		Secret           string `json:"secret"` // TFA session secret
		AutoLogin        bool   `json:"autoLogin"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid JSON"})
		return
	}

	totpCode := body.VerificationCode
	if totpCode == "" {
		totpCode = body.TfaCode
	}

	// ── TFA verification step ──
	if totpCode != "" && body.Secret != "" {
		s.handleClientTFAVerify(w, clientIP, totpCode, body.Secret)
		return
	}

	// ── Initial login step ──
	if body.Username == "" || body.Password == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Missing credentials"})
		return
	}

	user, err := s.db.GetUser(body.Username)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal error"})
		return
	}
	if user == nil || !auth.VerifyPassword(user.PasswordHash, body.Password) {
		if s.auditLog != nil {
			s.auditLog.Log(audit.ActionAuthLoginFailed, clientIP, body.Username, nil)
		}
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Invalid credentials"})
		return
	}

	// Check if TOTP 2FA is required
	if user.TOTPEnabled && user.TOTPSecret != "" {
		secret := make([]byte, 16)
		if _, err := rand.Read(secret); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal error"})
			return
		}
		tfaSecret := hex.EncodeToString(secret)

		s.clientTFASessions.put(tfaSecret, &tfaSession{
			username:  user.Username,
			role:      user.Role,
			userID:    user.ID,
			clientID:  body.ID,
			clientIP:  clientIP,
			createdAt: time.Now(),
		})

		if s.auditLog != nil {
			s.auditLog.Log(audit.ActionAuthLoginFailed, clientIP, user.Username,
				map[string]string{"reason": "2fa_required", "client_id": body.ID})
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"type":     "tfa_check",
			"tfa_type": "totp",
			"secret":   tfaSecret,
		})
		return
	}

	// No 2FA — issue token
	token, err := s.jwtManager.Generate(user.Username, user.Role)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Token generation failed"})
		return
	}

	_ = s.db.UpdateUserLogin(user.ID)

	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionAuthLogin, clientIP, user.Username,
			map[string]string{"client_id": body.ID})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"type":         "access_token",
		"access_token": token,
		"user":         rustdeskUserPayload(user.Username, user.Role),
	})
}

// handleClientTFAVerify completes the TOTP step for a RustDesk client login.
func (s *Server) handleClientTFAVerify(w http.ResponseWriter, clientIP, totpCode, secret string) {
	sess := s.clientTFASessions.take(secret)
	if sess == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Invalid or expired TFA session"})
		return
	}

	// Validate TOTP code length (6 digits)
	if len(totpCode) != 6 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Invalid verification code"})
		return
	}

	user, err := s.db.GetUser(sess.username)
	if err != nil || user == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "User not found"})
		return
	}

	if !auth.ValidateTOTP(user.TOTPSecret, totpCode) {
		if s.auditLog != nil {
			s.auditLog.Log(audit.ActionAuthLoginFailed, clientIP, sess.username,
				map[string]string{"reason": "invalid_totp", "client_id": sess.clientID})
		}
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Invalid verification code"})
		return
	}

	token, err := s.jwtManager.Generate(user.Username, user.Role)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Token generation failed"})
		return
	}

	_ = s.db.UpdateUserLogin(user.ID)

	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionAuthLogin, clientIP, user.Username,
			map[string]string{"client_id": sess.clientID, "method": "totp"})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"type":         "access_token",
		"access_token": token,
		"user":         rustdeskUserPayload(user.Username, user.Role),
	})
}

// handleClientLoginOptions returns available authentication methods.
// GET /api/login-options
func (s *Server) handleClientLoginOptions(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, []string{"account"})
}

// handleClientLogout handles logout for RustDesk clients.
// POST /api/logout
// With stateless JWT tokens, this is essentially a no-op on the server side.
func (s *Server) handleClientLogout(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleClientCurrentUser returns the current user info from Bearer token.
// GET /api/currentUser
func (s *Server) handleClientCurrentUser(w http.ResponseWriter, r *http.Request) {
	username := getUsernameFromCtx(r)
	role := getRoleFromCtx(r)
	if username == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Not authenticated"})
		return
	}
	writeJSON(w, http.StatusOK, rustdeskUserPayload(username, role))
}

// handleClientAddressBook handles address book get/set for RustDesk clients.
// GET /api/ab — get address book
// POST /api/ab — update address book
// TODO: Implement when address book table is added to the Go server DB.
func (s *Server) handleClientAddressBook(w http.ResponseWriter, r *http.Request) {
	username := getUsernameFromCtx(r)
	if username == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Not authenticated"})
		return
	}

	switch r.Method {
	case http.MethodGet:
		// Return empty address book until DB support is added
		writeJSON(w, http.StatusOK, map[string]any{"data": "{}"})

	case http.MethodPost:
		// Accept but silently discard until DB support is added
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})

	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
	}
}

// handleClientHeartbeat accepts heartbeat pings from RustDesk clients.
// POST /api/heartbeat
// Request:  { "id": "DEVICE_ID", "uuid": "...", "cpu": 42, "memory": 55, "disk": 30 }
// Response: { "modified_at": "2026-...", "sysinfo": true } (if sysinfo needed)
//           { "modified_at": "2026-..." }                   (normal ACK)
func (s *Server) handleClientHeartbeat(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID   string `json:"id"`
		UUID string `json:"uuid"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusOK, map[string]string{"modified_at": time.Now().UTC().Format(time.RFC3339)})
		return
	}

	deviceID := body.ID
	if deviceID == "" {
		deviceID = body.UUID
	}
	if deviceID == "" || !peerIDRegexp.MatchString(deviceID) {
		writeJSON(w, http.StatusOK, map[string]string{"modified_at": time.Now().UTC().Format(time.RFC3339)})
		return
	}

	// Verify peer exists
	peer, err := s.db.GetPeer(deviceID)
	if err != nil || peer == nil {
		writeJSON(w, http.StatusOK, map[string]string{"modified_at": time.Now().UTC().Format(time.RFC3339)})
		return
	}

	if peer.Banned {
		writeJSON(w, http.StatusOK, map[string]string{"error": "BANNED"})
		return
	}

	// Update peer status to ONLINE
	clientIP := s.remoteIP(r)
	_ = s.db.UpdatePeerStatus(deviceID, "ONLINE", clientIP)

	// Request sysinfo if hostname is empty (never received)
	if peer.Hostname == "" {
		writeJSON(w, http.StatusOK, map[string]any{
			"modified_at": time.Now().UTC().Format(time.RFC3339),
			"sysinfo":     true,
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"modified_at": time.Now().UTC().Format(time.RFC3339)})
}

// handleClientSysinfo receives hardware/software info from RustDesk clients.
// POST /api/sysinfo
// Request:  { "id": "DEVICE_ID", "hostname": "...", "platform": "...", "os": "...", "version": "..." ... }
// Response: plain text "SYSINFO_UPDATED" (activates PRO mode in client),
//           "ID_NOT_FOUND" (client retries), or "ERROR".
func (s *Server) handleClientSysinfo(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID       string `json:"id"`
		UUID     string `json:"uuid"`
		Hostname string `json:"hostname"`
		Platform string `json:"platform"`
		OS       string `json:"os"`
		Version  string `json:"version"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("ID_NOT_FOUND")) //nolint:errcheck
		return
	}

	deviceID := body.ID
	if deviceID == "" {
		deviceID = body.UUID
	}
	if deviceID == "" || !peerIDRegexp.MatchString(deviceID) {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("ID_NOT_FOUND")) //nolint:errcheck
		return
	}

	// Verify peer exists
	peer, err := s.db.GetPeer(deviceID)
	if err != nil || peer == nil {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("ID_NOT_FOUND")) //nolint:errcheck
		return
	}

	if peer.Banned {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("ID_NOT_FOUND")) //nolint:errcheck
		return
	}

	// Use platform or os field (RustDesk client may send either)
	osValue := body.Platform
	if osValue == "" {
		osValue = body.OS
	}

	// Truncate fields to safe lengths
	hostname := truncate(body.Hostname, 255)
	osVal := truncate(osValue, 255)
	version := truncate(body.Version, 64)

	if err := s.db.UpdatePeerSysinfo(deviceID, hostname, osVal, version); err != nil {
		s.auditLog.Log(audit.ActionSysinfoError, deviceID, "sysinfo", map[string]string{"error": err.Error()})
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("ERROR")) //nolint:errcheck
		return
	}

	s.auditLog.Log(audit.ActionSysinfoUpdated, deviceID, "sysinfo", map[string]string{
		"hostname": hostname,
		"os":       osVal,
		"version":  version,
	})

	w.Header().Set("Content-Type", "text/plain")
	w.Write([]byte("SYSINFO_UPDATED")) //nolint:errcheck
}

// handleClientSysinfoVer checks if sysinfo needs to be re-uploaded.
// POST /api/sysinfo_ver
// Returns a hash of existing sysinfo; empty response triggers full upload.
func (s *Server) handleClientSysinfoVer(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID   string `json:"id"`
		UUID string `json:"uuid"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("")) //nolint:errcheck
		return
	}

	deviceID := body.ID
	if deviceID == "" {
		deviceID = body.UUID
	}
	if deviceID == "" || !peerIDRegexp.MatchString(deviceID) {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("")) //nolint:errcheck
		return
	}

	peer, err := s.db.GetPeer(deviceID)
	if err != nil || peer == nil || peer.Hostname == "" {
		// No sysinfo → trigger upload
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("")) //nolint:errcheck
		return
	}

	// Build a deterministic hash from stored sysinfo fields
	h := sha256.New()
	h.Write([]byte(peer.Hostname))
	h.Write([]byte(peer.OS))
	h.Write([]byte(peer.Version))
	hash := hex.EncodeToString(h.Sum(nil))[:16]

	w.Header().Set("Content-Type", "text/plain")
	w.Write([]byte(hash)) //nolint:errcheck
}

// truncate returns s capped at maxLen bytes.
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen]
}
