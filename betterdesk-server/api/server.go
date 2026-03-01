// Package api implements the BetterDesk HTTP REST API server.
// Provides endpoints for peer management, server health, statistics,
// detailed device status, blocklist management, and bandwidth stats.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/unitronix/betterdesk-server/audit"
	"github.com/unitronix/betterdesk-server/auth"
	"github.com/unitronix/betterdesk-server/config"
	"github.com/unitronix/betterdesk-server/crypto"
	"github.com/unitronix/betterdesk-server/db"
	eventsModule "github.com/unitronix/betterdesk-server/events"
	"github.com/unitronix/betterdesk-server/metrics"
	"github.com/unitronix/betterdesk-server/peer"
	"github.com/unitronix/betterdesk-server/ratelimit"
	"github.com/unitronix/betterdesk-server/relay"
	"github.com/unitronix/betterdesk-server/security"

	"github.com/coder/websocket"
)

// peerIDRegexp validates RustDesk peer ID format: 6-16 alphanumeric chars, hyphens, underscores.
// Mirrors the validation in signal/handler.go — must be kept in sync.
var peerIDRegexp = regexp.MustCompile(`^[A-Za-z0-9_-]{6,16}$`)

// configKeyRegexp validates config key names: 1-64 alphanumeric chars, underscores, hyphens, dots.
// Prevents arbitrary key injection into the server_config table.
var configKeyRegexp = regexp.MustCompile(`^[A-Za-z0-9_.\-]{1,64}$`)

// Server is the HTTP API server.
type Server struct {
	cfg          *config.Config
	db           db.Database
	peers        *peer.Map
	relay        *relay.Server
	blocklist    *security.Blocklist
	bwLimiter    *ratelimit.BandwidthLimiter
	auditLog     *audit.Logger
	eventBus     *eventsModule.Bus
	metrics      *metrics.Collector
	jwtManager   *auth.JWTManager
	loginLimiter *ratelimit.IPLimiter
	keyPair      *crypto.KeyPair // Ed25519 keypair for signing
	httpSrv      *http.Server
	wg           sync.WaitGroup
	version      string
}

// New creates a new API server.
func New(cfg *config.Config, database db.Database, peerMap *peer.Map, relaySrv *relay.Server, version string) *Server {
	return &Server{
		cfg:          cfg,
		db:           database,
		peers:        peerMap,
		relay:        relaySrv,
		version:      version,
		loginLimiter: ratelimit.NewIPLimiter(5, 5*time.Minute, 10*time.Minute),
	}
}

// SetBlocklist sets the blocklist instance for the API server.
func (s *Server) SetBlocklist(bl *security.Blocklist) {
	s.blocklist = bl
}

// SetBandwidthLimiter sets the bandwidth limiter for stats reporting.
func (s *Server) SetBandwidthLimiter(bw *ratelimit.BandwidthLimiter) {
	s.bwLimiter = bw
}

// SetAuditLogger sets the audit logger for recording admin actions.
func (s *Server) SetAuditLogger(al *audit.Logger) {
	s.auditLog = al
}

// SetEventBus sets the event bus for real-time WebSocket push.
func (s *Server) SetEventBus(eb *eventsModule.Bus) {
	s.eventBus = eb
}

// SetMetrics sets the Prometheus metrics collector.
func (s *Server) SetMetrics(m *metrics.Collector) {
	s.metrics = m
}

// SetJWTManager sets the JWT manager for auth.
func (s *Server) SetJWTManager(jm *auth.JWTManager) {
	s.jwtManager = jm
}

// SetKeyPair sets the Ed25519 keypair for the server (used for signing IdPk).
func (s *Server) SetKeyPair(kp *crypto.KeyPair) {
	s.keyPair = kp
}

// Start launches the HTTP API server.
func (s *Server) Start(ctx context.Context) error {
	mux := http.NewServeMux()

	// Health + info (public, no auth required)
	mux.HandleFunc("GET /api/health", s.handleHealth)
	mux.HandleFunc("GET /api/server/stats", s.handleServerStats)
	mux.HandleFunc("GET /api/server/pubkey", s.handlePubKey)

	// Peers
	mux.HandleFunc("GET /api/peers", s.handleListPeers)
	mux.HandleFunc("GET /api/peers/{id}", s.handleGetPeer)
	mux.HandleFunc("DELETE /api/peers/{id}", s.requireRole(auth.RoleAdmin, s.handleDeletePeer))
	mux.HandleFunc("POST /api/peers/{id}/ban", s.requireRole(auth.RoleAdmin, s.handleBanPeer))
	mux.HandleFunc("POST /api/peers/{id}/unban", s.requireRole(auth.RoleAdmin, s.handleUnbanPeer))
	mux.HandleFunc("POST /api/peers/{id}/change-id", s.requireRole(auth.RoleAdmin, s.handleChangePeerID))

	// Detailed device status (enhanced in Phase 4)
	mux.HandleFunc("GET /api/peers/status/summary", s.handleStatusSummary)
	mux.HandleFunc("GET /api/peers/online", s.handleOnlinePeers)
	mux.HandleFunc("GET /api/peers/{id}/status", s.handlePeerStatus)

	// Blocklist management
	mux.HandleFunc("GET /api/blocklist", s.handleListBlocklist)
	mux.HandleFunc("POST /api/blocklist", s.requireRole(auth.RoleAdmin, s.handleAddBlocklist))
	mux.HandleFunc("DELETE /api/blocklist/{entry}", s.requireRole(auth.RoleAdmin, s.handleRemoveBlocklist))

	// Tags
	mux.HandleFunc("PUT /api/peers/{id}/tags", s.handleSetPeerTags)
	mux.HandleFunc("GET /api/tags/{tag}/peers", s.handlePeersByTag)

	// Audit
	mux.HandleFunc("GET /api/audit/events", s.handleAuditEvents)

	// WebSocket real-time events
	mux.HandleFunc("GET /api/ws/events", s.handleWSEvents)

	// Config
	mux.HandleFunc("GET /api/config/{key}", s.requireRole(auth.RoleAdmin, s.handleGetConfig))
	mux.HandleFunc("PUT /api/config/{key}", s.requireRole(auth.RoleAdmin, s.handleSetConfig))

	// Auth (public — no auth required, handled by middleware exclusion)
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/auth/login/2fa", s.handleLogin2FA)
	mux.HandleFunc("GET /api/auth/me", s.handleAuthMe)

	// User management (admin only)
	mux.HandleFunc("GET /api/users", s.requireRole(auth.RoleAdmin, s.handleListUsers))
	mux.HandleFunc("POST /api/users", s.requireRole(auth.RoleAdmin, s.handleCreateUser))
	mux.HandleFunc("PUT /api/users/{id}", s.requireRole(auth.RoleAdmin, s.handleUpdateUser))
	mux.HandleFunc("DELETE /api/users/{id}", s.requireRole(auth.RoleAdmin, s.handleDeleteUser))

	// TOTP management (admin only)
	mux.HandleFunc("POST /api/users/{id}/totp/setup", s.requireRole(auth.RoleAdmin, s.handleSetupTOTP))
	mux.HandleFunc("POST /api/users/{id}/totp/confirm", s.requireRole(auth.RoleAdmin, s.handleConfirmTOTP))
	mux.HandleFunc("DELETE /api/users/{id}/totp", s.requireRole(auth.RoleAdmin, s.handleDisableTOTP))

	// API key management (admin only)
	mux.HandleFunc("GET /api/keys", s.requireRole(auth.RoleAdmin, s.handleListAPIKeys))
	mux.HandleFunc("POST /api/keys", s.requireRole(auth.RoleAdmin, s.handleCreateAPIKey))
	mux.HandleFunc("DELETE /api/keys/{id}", s.requireRole(auth.RoleAdmin, s.handleDeleteAPIKey))

	// Device token management (Dual Key System - admin only)
	mux.HandleFunc("GET /api/tokens", s.requireRole(auth.RoleAdmin, s.handleListDeviceTokens))
	mux.HandleFunc("POST /api/tokens", s.requireRole(auth.RoleAdmin, s.handleCreateDeviceToken))
	mux.HandleFunc("GET /api/tokens/{id}", s.requireRole(auth.RoleAdmin, s.handleGetDeviceToken))
	mux.HandleFunc("PUT /api/tokens/{id}", s.requireRole(auth.RoleAdmin, s.handleUpdateDeviceToken))
	mux.HandleFunc("DELETE /api/tokens/{id}", s.requireRole(auth.RoleAdmin, s.handleRevokeDeviceToken))
	mux.HandleFunc("POST /api/tokens/generate-bulk", s.requireRole(auth.RoleAdmin, s.handleBulkGenerateTokens))
	mux.HandleFunc("POST /api/tokens/{id}/bind", s.requireRole(auth.RoleAdmin, s.handleBindTokenToPeer))

	// Enrollment mode management (Dual Key System - admin only)
	mux.HandleFunc("GET /api/enrollment/mode", s.requireRole(auth.RoleAdmin, s.handleGetEnrollmentMode))
	mux.HandleFunc("PUT /api/enrollment/mode", s.requireRole(auth.RoleAdmin, s.handleSetEnrollmentMode))

	// Prometheus metrics (public, no API key required)
	mux.HandleFunc("GET /metrics", s.handleMetrics)

	addr := fmt.Sprintf(":%d", s.cfg.APIPort)
	s.httpSrv = &http.Server{
		Addr:         addr,
		Handler:      s.authMiddleware(mux),
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
		BaseContext: func(l net.Listener) context.Context {
			return ctx
		},
	}

	// Enable TLS if certificate and key are configured
	useTLS := s.cfg.HasTLSCert()
	if useTLS {
		tlsCfg, err := config.LoadTLSConfig(s.cfg.TLSCertFile, s.cfg.TLSKeyFile)
		if err != nil {
			return fmt.Errorf("api: %w", err)
		}
		s.httpSrv.TLSConfig = tlsCfg
	}

	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		if useTLS {
			log.Printf("[api] HTTPS listening on %s (TLS enabled)", addr)
			if err := s.httpSrv.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
				log.Printf("[api] HTTPS server error: %v", err)
			}
		} else {
			log.Printf("[api] HTTP listening on %s", addr)
			if err := s.httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Printf("[api] HTTP server error: %v", err)
			}
		}
	}()

	return nil
}

// Stop gracefully shuts down the HTTP server.
func (s *Server) Stop() {
	log.Printf("[api] Shutting down...")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s.httpSrv.Shutdown(ctx)
	s.wg.Wait()
	log.Printf("[api] Stopped")
}

// --- Middleware ---

// --- Handlers ---

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	total, online, _ := s.db.GetPeerCount()
	writeJSON(w, http.StatusOK, map[string]any{
		"status":       "ok",
		"version":      s.version,
		"peers_total":  total,
		"peers_online": online,
		"uptime":       time.Since(startTime).String(),
		"tls":          s.cfg.TLSCertFile != "" && s.cfg.TLSKeyFile != "",
	})
}

// handlePubKey returns the server's Ed25519 public key in base64 format.
// This is the "key" value that RustDesk clients use for E2E encryption verification.
// Public endpoint — no authentication required.
func (s *Server) handlePubKey(w http.ResponseWriter, r *http.Request) {
	if s.keyPair == nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Server keypair not initialized",
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"key":     s.keyPair.PublicKeyBase64(),
		"key_hex": fmt.Sprintf("%x", s.keyPair.PublicKey),
	})
}

func (s *Server) handleServerStats(w http.ResponseWriter, r *http.Request) {
	total, online, _ := s.db.GetPeerCount()
	memStats := runtime.MemStats{}
	runtime.ReadMemStats(&memStats)

	peerStats := s.peers.GetStats(config.DegradedThreshold, config.CriticalThreshold)

	stats := map[string]any{
		"version":         s.version,
		"go_version":      runtime.Version(),
		"os":              runtime.GOOS,
		"arch":            runtime.GOARCH,
		"goroutines":      runtime.NumGoroutine(),
		"memory_alloc_mb": float64(memStats.Alloc) / 1024 / 1024,
		"memory_sys_mb":   float64(memStats.Sys) / 1024 / 1024,
		"peers_total":     total,
		"peers_online":    online,
		"peers_in_memory": s.peers.Count(),
		"uptime":          time.Since(startTime).String(),
		"uptime_seconds":  int(time.Since(startTime).Seconds()),
		// Enhanced status stats from peer map
		"peers_online_live":   peerStats.Online,
		"peers_degraded":      peerStats.Degraded,
		"peers_critical":      peerStats.Critical,
		"peers_udp":           peerStats.UDP,
		"peers_tcp":           peerStats.TCP,
		"peers_ws":            peerStats.WS,
		"peers_banned":        peerStats.Banned,
		"peers_disabled":      peerStats.Disabled,
		"avg_uptime_secs":     peerStats.AvgUptimeSecs,
		"avg_beat_age_secs":   peerStats.AvgBeatAge,
		"total_registrations": s.peers.TotalRegistrations(),
		"total_expired":       s.peers.TotalExpired(),
	}

	if s.relay != nil {
		stats["relay_active_sessions"] = s.relay.ActiveSessions.Load()
		stats["relay_total_relayed"] = s.relay.TotalRelayed.Load()
	}

	if s.bwLimiter != nil {
		bwStats := s.bwLimiter.Stats()
		stats["bandwidth_bytes_transferred"] = bwStats.TotalBytesTransferred
		stats["bandwidth_active_sessions"] = bwStats.ActiveSessions
		stats["bandwidth_throttle_hits"] = bwStats.ThrottleHits
	}

	if s.blocklist != nil {
		stats["blocklist_count"] = s.blocklist.Count()
	}

	writeJSON(w, http.StatusOK, stats)
}

func (s *Server) handleListPeers(w http.ResponseWriter, r *http.Request) {
	includeDeleted := r.URL.Query().Get("include_deleted") == "true"
	peers, err := s.db.ListPeers(includeDeleted)
	if err != nil {
		writeInternalError(w, err, "ListPeers")
		return
	}

	// Enrich with live online status and status tier from memory map
	type peerResponse struct {
		*db.Peer
		LiveOnline bool        `json:"live_online"`
		LiveStatus peer.Status `json:"live_status"`
	}

	result := make([]peerResponse, len(peers))
	for i, p := range peers {
		liveOnline := s.peers.IsOnline(p.ID, config.RegTimeout)
		liveStatus := peer.StatusOffline
		if snap, ok := s.peers.GetSnapshot(p.ID, config.DegradedThreshold, config.CriticalThreshold); ok {
			liveStatus = snap.Status
		}
		result[i] = peerResponse{
			Peer:       p,
			LiveOnline: liveOnline,
			LiveStatus: liveStatus,
		}
	}

	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleGetPeer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	p, err := s.db.GetPeer(id)
	if err != nil {
		writeInternalError(w, err, "GetPeer")
		return
	}
	if p == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "Peer not found"})
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) handleDeletePeer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	hard := r.URL.Query().Get("hard") == "true"

	var err error
	if hard {
		err = s.db.HardDeletePeer(id)
	} else {
		err = s.db.DeletePeer(id)
	}
	if err != nil {
		writeInternalError(w, err, "DeletePeer")
		return
	}

	// Also remove from memory
	s.peers.Remove(id)

	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionPeerDeleted, s.remoteIP(r), id, map[string]string{"hard": fmt.Sprintf("%v", hard)})
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted", "id": id})
}

func (s *Server) handleBanPeer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	var body struct {
		Reason string `json:"reason"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	if err := s.db.BanPeer(id, body.Reason); err != nil {
		writeInternalError(w, err, "BanPeer")
		return
	}

	// Mark as banned in memory too
	entry := s.peers.Get(id)
	if entry != nil {
		entry.Banned = true
	}

	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionPeerBanned, s.remoteIP(r), id, map[string]string{"reason": body.Reason})
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "banned", "id": id})
}

func (s *Server) handleUnbanPeer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.db.UnbanPeer(id); err != nil {
		writeInternalError(w, err, "UnbanPeer")
		return
	}

	entry := s.peers.Get(id)
	if entry != nil {
		entry.Banned = false
	}

	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionPeerUnbanned, s.remoteIP(r), id, nil)
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "unbanned", "id": id})
}

func (s *Server) handleChangePeerID(w http.ResponseWriter, r *http.Request) {
	oldID := r.PathValue("id")

	var body struct {
		NewID string `json:"new_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.NewID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "new_id is required"})
		return
	}

	// Validate new peer ID format (H1: prevent injection of arbitrary IDs)
	if !peerIDRegexp.MatchString(body.NewID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "Invalid peer ID format. Must be 6-16 alphanumeric characters, hyphens, or underscores.",
		})
		return
	}

	if err := s.db.ChangePeerID(oldID, body.NewID); err != nil {
		// Log the actual error but return a generic message to prevent leakage
		log.Printf("[API] ChangePeerID %s -> %s: %v", oldID, body.NewID, err)
		writeJSON(w, http.StatusConflict, map[string]string{"error": "Failed to change peer ID (ID conflict or not found)"})
		return
	}

	// Update memory map
	entry := s.peers.Remove(oldID)
	if entry != nil {
		entry.ID = body.NewID
		s.peers.Put(entry)
	}

	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionPeerIDChanged, s.remoteIP(r), oldID, map[string]string{"new_id": body.NewID})
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"status": "changed",
		"old_id": oldID,
		"new_id": body.NewID,
	})
}

func (s *Server) handleGetConfig(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")

	// M6: Validate config key name to prevent arbitrary key injection
	if !configKeyRegexp.MatchString(key) {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "Invalid config key. Must be 1-64 alphanumeric characters, underscores, hyphens, or dots.",
		})
		return
	}

	val, err := s.db.GetConfig(key)
	if err != nil {
		writeInternalError(w, err, "GetConfig")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"key": key, "value": val})
}

func (s *Server) handleSetConfig(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")

	// M6: Validate config key name to prevent arbitrary key injection
	if !configKeyRegexp.MatchString(key) {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "Invalid config key. Must be 1-64 alphanumeric characters, underscores, hyphens, or dots.",
		})
		return
	}

	var body struct {
		Value string `json:"value"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid JSON"})
		return
	}
	if err := s.db.SetConfig(key, body.Value); err != nil {
		writeInternalError(w, err, "SetConfig")
		return
	}

	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionConfigChanged, s.remoteIP(r), key, map[string]string{"value": body.Value})
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "key": key})
}

// --- New Phase 4 Handlers ---

// handleStatusSummary returns aggregate device status counts.
// GET /api/peers/status/summary
func (s *Server) handleStatusSummary(w http.ResponseWriter, r *http.Request) {
	stats := s.peers.GetStats(config.DegradedThreshold, config.CriticalThreshold)
	writeJSON(w, http.StatusOK, stats)
}

// handleOnlinePeers returns detailed snapshots of all currently online peers.
// GET /api/peers/online
func (s *Server) handleOnlinePeers(w http.ResponseWriter, r *http.Request) {
	snapshots := s.peers.GetAllSnapshots(config.DegradedThreshold, config.CriticalThreshold)
	writeJSON(w, http.StatusOK, map[string]any{
		"count": len(snapshots),
		"peers": snapshots,
	})
}

// handlePeerStatus returns detailed live status for a specific peer.
// GET /api/peers/{id}/status
func (s *Server) handlePeerStatus(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	snap, ok := s.peers.GetSnapshot(id, config.DegradedThreshold, config.CriticalThreshold)
	if !ok {
		// Not in memory — check database for historical data
		dbPeer, err := s.db.GetPeer(id)
		if err != nil {
			writeInternalError(w, err, "GetPeer (status)")
			return
		}
		if dbPeer == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "Peer not found"})
			return
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"id":          id,
			"status":      peer.StatusOffline,
			"in_memory":   false,
			"db_status":   dbPeer.Status,
			"last_online": dbPeer.LastOnline,
			"hostname":    dbPeer.Hostname,
			"os":          dbPeer.OS,
			"version":     dbPeer.Version,
		})
		return
	}

	// Peer is in memory — return full live snapshot
	writeJSON(w, http.StatusOK, map[string]any{
		"in_memory": true,
		"snapshot":  snap,
	})
}

// handleListBlocklist returns all blocklist entries.
// GET /api/blocklist
func (s *Server) handleListBlocklist(w http.ResponseWriter, r *http.Request) {
	if s.blocklist == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"enabled": false,
			"entries": []any{},
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled": true,
		"count":   s.blocklist.Count(),
		"entries": s.blocklist.List(),
	})
}

// handleAddBlocklist adds an entry to the blocklist.
// POST /api/blocklist
func (s *Server) handleAddBlocklist(w http.ResponseWriter, r *http.Request) {
	if s.blocklist == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "Blocklist not enabled",
		})
		return
	}

	var body struct {
		Value  string `json:"value"`
		Type   string `json:"type"` // "ip", "id", or "cidr"
		Reason string `json:"reason"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Value == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "value is required"})
		return
	}

	switch body.Type {
	case "ip":
		s.blocklist.BlockIP(body.Value, body.Reason)
	case "id":
		s.blocklist.BlockID(body.Value, body.Reason)
	case "cidr":
		if err := s.blocklist.BlockCIDR(body.Value, body.Reason); err != nil {
			log.Printf("[API] Invalid CIDR %s: %v", body.Value, err)
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid CIDR notation"})
			return
		}
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "type must be ip, id, or cidr"})
		return
	}

	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionBlocklistAdd, s.remoteIP(r), body.Value, map[string]string{
			"type": body.Type, "reason": body.Reason,
		})
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "blocked", "value": body.Value})
}

// handleRemoveBlocklist removes an entry from the blocklist.
// DELETE /api/blocklist/{entry}
func (s *Server) handleRemoveBlocklist(w http.ResponseWriter, r *http.Request) {
	entry := r.PathValue("entry")
	if s.blocklist == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "Blocklist not enabled",
		})
		return
	}

	removed := s.blocklist.UnblockIP(entry) || s.blocklist.UnblockID(entry) || s.blocklist.UnblockCIDR(entry)
	if !removed {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "Entry not found"})
		return
	}

	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionBlocklistRemove, s.remoteIP(r), entry, nil)
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "unblocked", "entry": entry})
}

// --- Helpers ---

var startTime = time.Now()

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

// writeInternalError logs the actual error internally and returns a generic
// "Internal server error" message to the client. This prevents leaking
// sensitive implementation details (file paths, SQL queries, stack traces).
func writeInternalError(w http.ResponseWriter, err error, action string) {
	log.Printf("[API] %s failed: %v", action, err)
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error"})
}

// remoteIP extracts the client IP from a request.
// When TrustProxy is enabled, respects X-Forwarded-For and X-Real-IP headers.
// When disabled, always uses the direct connection address.
func (s *Server) remoteIP(r *http.Request) string {
	if s.cfg.TrustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			// Use the first (leftmost) IP — the original client
			if idx := strings.Index(xff, ","); idx != -1 {
				return strings.TrimSpace(xff[:idx])
			}
			return strings.TrimSpace(xff)
		}
		if xri := r.Header.Get("X-Real-IP"); xri != "" {
			return strings.TrimSpace(xri)
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// --- Tags Handlers ---

// handleSetPeerTags updates tags for a peer.
// PUT /api/peers/{id}/tags
func (s *Server) handleSetPeerTags(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	var body struct {
		Tags string `json:"tags"` // comma-separated tags
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid JSON"})
		return
	}

	if err := s.db.UpdatePeerTags(id, body.Tags); err != nil {
		writeInternalError(w, err, "UpdatePeerTags")
		return
	}

	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionPeerTagsUpdated, s.remoteIP(r), id, map[string]string{"tags": body.Tags})
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "updated", "id": id, "tags": body.Tags})
}

// handlePeersByTag returns peers matching a tag.
// GET /api/peers/by-tag/{tag}
func (s *Server) handlePeersByTag(w http.ResponseWriter, r *http.Request) {
	tag := r.PathValue("tag")
	peers, err := s.db.ListPeersByTag(tag)
	if err != nil {
		writeInternalError(w, err, "ListPeersByTag")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"tag":   tag,
		"count": len(peers),
		"peers": peers,
	})
}

// --- Audit Handler ---

// handleAuditEvents returns recent audit events.
// GET /api/audit/events?limit=50&action=peer_banned
func (s *Server) handleAuditEvents(w http.ResponseWriter, r *http.Request) {
	if s.auditLog == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"enabled": false,
			"events":  []any{},
		})
		return
	}

	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := fmt.Sscanf(v, "%d", &limit); err != nil || n != 1 {
			limit = 50
		}
	}
	if limit > 1000 {
		limit = 1000
	}

	action := r.URL.Query().Get("action")
	var events []audit.Event
	if action != "" {
		events = s.auditLog.RecentByAction(audit.Action(action), limit)
	} else {
		events = s.auditLog.Recent(limit)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"enabled": true,
		"total":   s.auditLog.Total(),
		"count":   len(events),
		"events":  events,
	})
}

// --- Metrics Handler ---

// handleMetrics serves Prometheus text exposition format metrics.
// GET /metrics
func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	if s.metrics == nil {
		http.Error(w, "metrics not available", http.StatusServiceUnavailable)
		return
	}

	// Refresh gauge values from current state
	if s.peers != nil {
		snap := s.peers.GetAllSnapshots(
			config.DegradedThreshold,
			config.CriticalThreshold,
		)
		var online, degraded, critical, offline int64
		for _, p := range snap {
			switch p.Status {
			case peer.StatusOnline:
				online++
			case peer.StatusDegraded:
				degraded++
			case peer.StatusCritical:
				critical++
			default:
				offline++
			}
		}
		s.metrics.PeersTotal.Store(int64(len(snap)))
		s.metrics.PeersOnline.Store(online)
		s.metrics.PeersDegraded.Store(degraded)
		s.metrics.PeersCritical.Store(critical)
		s.metrics.PeersOffline.Store(offline)
	}

	if s.blocklist != nil {
		s.metrics.BlocklistCount.Store(int64(s.blocklist.Count()))
	}

	if s.eventBus != nil {
		s.metrics.EventSubscribers.Store(int64(s.eventBus.Count()))
	}

	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	s.metrics.WritePrometheus(w)
}

// --- WebSocket Events Handler ---

// handleWSEvents upgrades the HTTP connection to WebSocket and streams events.
// GET /api/ws/events?filter=peer_online
func (s *Server) handleWSEvents(w http.ResponseWriter, r *http.Request) {
	if s.eventBus == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "Event bus not available",
		})
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // Allow cross-origin for admin tools
	})
	if err != nil {
		log.Printf("[api] WebSocket upgrade failed: %v", err)
		return
	}
	defer conn.CloseNow()

	filter := eventsModule.EventType(r.URL.Query().Get("filter"))
	sub := s.eventBus.Subscribe(filter)
	defer s.eventBus.Unsubscribe(sub)

	ctx := r.Context()
	log.Printf("[api] WebSocket events client connected (filter=%q)", filter)

	for {
		select {
		case <-ctx.Done():
			conn.Close(websocket.StatusNormalClosure, "server closing")
			return
		case evt, ok := <-sub.Ch:
			if !ok {
				conn.Close(websocket.StatusNormalClosure, "unsubscribed")
				return
			}
			data := eventsModule.MarshalEvent(evt)
			if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
				log.Printf("[api] WebSocket write error: %v", err)
				return
			}
		}
	}
}
