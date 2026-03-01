package relay

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"

	"github.com/coder/websocket"
	"github.com/unitronix/betterdesk-server/codec"
	"github.com/unitronix/betterdesk-server/config"
	pb "github.com/unitronix/betterdesk-server/proto"
)

// serveWS starts the WebSocket relay listener (e.g., port 21119).
// RustDesk web clients use this for relay traffic over WebSocket.
// The WS connection is adapted to net.Conn so the existing relay
// pairing logic works unmodified.
// Phase 3: Supports WSS when TLS is enabled for relay server.
func (s *Server) serveWS() {
	defer s.wg.Done()

	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleWSRelayUpgrade)

	addr := fmt.Sprintf(":%d", s.cfg.WSRelayPort())
	s.wsHTTP = &http.Server{
		Addr:         addr,
		Handler:      mux,
		ReadTimeout:  config.RelayPairTimeout,
		WriteTimeout: 0, // No write timeout for relay pipe
		BaseContext: func(l net.Listener) context.Context {
			return s.ctx
		},
	}

	// Phase 3: Enable WSS if TLS is configured for relay server.
	if s.cfg.RelayTLSEnabled() {
		tlsCfg, err := config.LoadTLSConfig(s.cfg.TLSCertFile, s.cfg.TLSKeyFile)
		if err != nil {
			log.Printf("[relay] WSS TLS config error: %v", err)
			return
		}
		s.wsHTTP.TLSConfig = tlsCfg
		log.Printf("[relay] WSS listening on %s (TLS enabled)", addr)
		if err := s.wsHTTP.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
			log.Printf("[relay] WSS server error: %v", err)
		}
	} else {
		log.Printf("[relay] WS listening on %s", addr)
		if err := s.wsHTTP.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("[relay] WS server error: %v", err)
		}
	}
}

// handleWSRelayUpgrade upgrades to WebSocket and handles relay pairing.
// After upgrade, the first binary frame must be a RequestRelay (with UUID).
// Then we convert the WS to a net.Conn and feed it into the existing pairing logic.
func (s *Server) handleWSRelayUpgrade(w http.ResponseWriter, r *http.Request) {
	opts := &websocket.AcceptOptions{}

	// M3: Validate WebSocket origin if configured.
	allowed := s.cfg.GetAllowedWSOrigins()
	if len(allowed) > 0 {
		opts.OriginPatterns = allowed
	} else {
		opts.InsecureSkipVerify = true
	}

	ws, err := websocket.Accept(w, r, opts)
	if err != nil {
		log.Printf("[relay] WS upgrade error: %v", err)
		return
	}

	// Increase read limit for relay data
	ws.SetReadLimit(8 * 1024 * 1024) // 8 MB

	wsc := codec.NewWSConn(ws, s.ctx, r.RemoteAddr)

	// Read the first message — must be RequestRelay or HealthCheck
	msg, err := wsc.ReadMessage()
	if err != nil {
		wsc.Close()
		return
	}

	// Handle health check
	if hc := msg.GetHc(); hc != nil {
		resp := &pb.RendezvousMessage{
			Union: &pb.RendezvousMessage_Hc{
				Hc: &pb.HealthCheck{Token: hc.Token},
			},
		}
		wsc.WriteMessage(resp)
		wsc.Close()
		return
	}

	rr := msg.GetRequestRelay()
	if rr == nil || rr.Uuid == "" {
		wsc.Close()
		return
	}

	uuid := rr.Uuid
	log.Printf("[relay] WS connection from %s for UUID %s", r.RemoteAddr, uuid)

	// Convert WS to net.Conn for the standard relay pairing pipeline.
	// websocket.NetConn wraps the WS with binary message framing as a stream.
	netConn := codec.WSToNetConn(ws)

	// Inject into the same pairing logic used by TCP.
	// First, send the initial message as a framed packet so handleConn sees it.
	// Actually, we can directly call the pairing logic here.
	s.pairWSConn(netConn, uuid)
}

// pairWSConn pairs a WebSocket-derived net.Conn using the same UUID logic as TCP.
func (s *Server) pairWSConn(conn net.Conn, uuid string) {
	// Try to find a pending connection with same UUID
	if val, loaded := s.pending.LoadAndDelete(uuid); loaded {
		pc := val.(*pendingConn)
		close(pc.done)
		s.startRelay(pc.conn, conn, uuid)
		return
	}

	// No pair yet — register as pending and wait
	pc := &pendingConn{
		conn:    conn,
		created: timeNow(),
		done:    make(chan struct{}),
	}
	s.pending.Store(uuid, pc)

	select {
	case <-pc.done:
		return
	case <-timeAfter(config.RelayPairTimeout):
		s.pending.Delete(uuid)
		log.Printf("[relay] WS pair timeout for UUID %s", uuid)
		conn.Close()
	case <-s.ctx.Done():
		s.pending.Delete(uuid)
		conn.Close()
	}
}

// NOTE: confirmRelay was removed — the RustDesk client does not expect
// a RelayResponse from the relay server. Sending one breaks the E2E
// encryption handshake (see startRelay comment in server.go).
