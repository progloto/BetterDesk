// Package cdap — desktop handles the binary/text WebSocket channel for
// remote desktop sessions between the admin panel and CDAP devices.
// Supports both frame-based (MJPEG/raw) and input relay (mouse/keyboard).
package cdap

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// DesktopSession represents an active remote desktop session relaying
// video frames from device→browser and input events from browser→device.
type DesktopSession struct {
	ID       string
	DeviceID string
	Username string
	Role     string

	browser    *websocket.Conn
	deviceConn *DeviceConn

	createdAt time.Time
	mu        sync.Mutex
	closed    atomic.Bool
}

// DesktopStartPayload is sent to the device to initiate a desktop session.
type DesktopStartPayload struct {
	SessionID string `json:"session_id"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	Quality   int    `json:"quality"` // JPEG quality 1-100
	FPS       int    `json:"fps"`     // target frames per second
}

// DesktopFramePayload is sent from the device to the browser.
type DesktopFramePayload struct {
	SessionID string `json:"session_id"`
	Format    string `json:"format"`    // jpeg, png, raw
	Width     int    `json:"width"`     // frame width
	Height    int    `json:"height"`    // frame height
	Data      string `json:"data"`      // base64-encoded frame data
	Timestamp int64  `json:"timestamp"` // capture timestamp ms
}

// DesktopInputPayload is sent from the browser to the device.
type DesktopInputPayload struct {
	SessionID string `json:"session_id"`
	InputType string `json:"input_type"` // mouse_move, mouse_down, mouse_up, key_down, key_up, scroll
	X         int    `json:"x,omitempty"`
	Y         int    `json:"y,omitempty"`
	Button    int    `json:"button,omitempty"` // 0=left, 1=middle, 2=right
	Key       string `json:"key,omitempty"`    // key name (e.g. "Enter", "a")
	Code      string `json:"code,omitempty"`   // key code (e.g. "KeyA")
	Modifiers int    `json:"modifiers,omitempty"`
	DeltaX    int    `json:"delta_x,omitempty"` // scroll delta
	DeltaY    int    `json:"delta_y,omitempty"`
}

// DesktopResizePayload is sent when the browser viewport resizes.
type DesktopResizePayload struct {
	SessionID string `json:"session_id"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
}

// DesktopEndPayload is sent when a desktop session ends.
type DesktopEndPayload struct {
	SessionID string `json:"session_id"`
	Reason    string `json:"reason,omitempty"`
}

// StartDesktopSession creates a new remote desktop session between the
// browser and a CDAP device for screen capture and input relay.
func (g *Gateway) StartDesktopSession(ctx context.Context, browserConn *websocket.Conn, deviceID, username, role string, width, height, quality, fps int) (*DesktopSession, error) {
	dc := g.GetDeviceConn(deviceID)
	if dc == nil {
		return nil, fmt.Errorf("device %s not connected", deviceID)
	}

	// Check that device supports remote_desktop capability
	if dc.Manifest != nil {
		hasDesktop := false
		for _, cap := range dc.Manifest.Capabilities {
			if cap == "remote_desktop" {
				hasDesktop = true
				break
			}
		}
		if !hasDesktop {
			return nil, fmt.Errorf("device %s does not support remote_desktop", deviceID)
		}
	}

	if quality <= 0 || quality > 100 {
		quality = 70
	}
	if fps <= 0 || fps > 60 {
		fps = 15
	}
	if width <= 0 {
		width = 1280
	}
	if height <= 0 {
		height = 720
	}

	sessionID := fmt.Sprintf("desk_%s_%d", deviceID, time.Now().UnixNano())

	ds := &DesktopSession{
		ID:         sessionID,
		DeviceID:   deviceID,
		Username:   username,
		Role:       role,
		browser:    browserConn,
		deviceConn: dc,
		createdAt:  time.Now(),
	}

	startPayload := DesktopStartPayload{
		SessionID: sessionID,
		Width:     width,
		Height:    height,
		Quality:   quality,
		FPS:       fps,
	}
	data, _ := json.Marshal(startPayload)
	msg := &Message{
		Type:      "desktop_start",
		ID:        sessionID,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Payload:   data,
	}

	if err := dc.WriteMessage(ctx, msg); err != nil {
		return nil, fmt.Errorf("send desktop_start to device: %w", err)
	}

	g.desktopSessions.Store(sessionID, ds)

	log.Printf("[cdap] Desktop session %s started for device %s by %s (%dx%d q%d @%dfps)",
		sessionID, deviceID, username, width, height, quality, fps)

	if g.auditLog != nil {
		g.auditLog.Log("cdap_desktop_started", dc.ClientIP, username, map[string]string{
			"session_id": sessionID,
			"device_id":  deviceID,
		})
	}

	return ds, nil
}

// RelayDesktopInput forwards mouse/keyboard input from browser to device.
func (g *Gateway) RelayDesktopInput(ctx context.Context, sessionID string, input *DesktopInputPayload) error {
	val, ok := g.desktopSessions.Load(sessionID)
	if !ok {
		return fmt.Errorf("desktop session %s not found", sessionID)
	}
	ds := val.(*DesktopSession)
	if ds.closed.Load() {
		return fmt.Errorf("desktop session %s is closed", sessionID)
	}

	input.SessionID = sessionID
	payloadData, _ := json.Marshal(input)
	msg := &Message{
		Type:      "desktop_input",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Payload:   payloadData,
	}

	return ds.deviceConn.WriteMessage(ctx, msg)
}

// RelayDesktopResize forwards a viewport resize from browser to device.
func (g *Gateway) RelayDesktopResize(ctx context.Context, sessionID string, width, height int) error {
	val, ok := g.desktopSessions.Load(sessionID)
	if !ok {
		return fmt.Errorf("desktop session %s not found", sessionID)
	}
	ds := val.(*DesktopSession)

	payload := DesktopResizePayload{
		SessionID: sessionID,
		Width:     width,
		Height:    height,
	}
	payloadData, _ := json.Marshal(payload)
	msg := &Message{
		Type:      "desktop_resize",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Payload:   payloadData,
	}

	return ds.deviceConn.WriteMessage(ctx, msg)
}

// HandleDesktopFrame is called when the device sends a captured frame.
// It forwards the frame to the browser WebSocket.
func (g *Gateway) HandleDesktopFrame(ctx context.Context, sessionID string, frame *DesktopFramePayload) error {
	val, ok := g.desktopSessions.Load(sessionID)
	if !ok {
		return fmt.Errorf("desktop session %s not found", sessionID)
	}
	ds := val.(*DesktopSession)
	if ds.closed.Load() {
		return nil
	}

	output := map[string]any{
		"type":       "frame",
		"session_id": sessionID,
		"format":     frame.Format,
		"width":      frame.Width,
		"height":     frame.Height,
		"data":       frame.Data,
		"timestamp":  frame.Timestamp,
	}
	outData, _ := json.Marshal(output)

	ds.mu.Lock()
	defer ds.mu.Unlock()
	return ds.browser.Write(ctx, websocket.MessageText, outData)
}

// EndDesktopSession terminates a desktop session.
func (g *Gateway) EndDesktopSession(ctx context.Context, sessionID, reason string) {
	val, ok := g.desktopSessions.LoadAndDelete(sessionID)
	if !ok {
		return
	}
	ds := val.(*DesktopSession)
	if ds.closed.Swap(true) {
		return
	}

	endPayload := DesktopEndPayload{
		SessionID: sessionID,
		Reason:    reason,
	}
	data, _ := json.Marshal(endPayload)
	msg := &Message{
		Type:      "desktop_end",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Payload:   data,
	}
	ds.deviceConn.WriteMessage(ctx, msg)

	endMsg, _ := json.Marshal(map[string]string{
		"type":       "end",
		"session_id": sessionID,
		"reason":     reason,
	})
	ds.mu.Lock()
	ds.browser.Write(ctx, websocket.MessageText, endMsg)
	ds.mu.Unlock()
	ds.browser.Close(websocket.StatusNormalClosure, reason)

	log.Printf("[cdap] Desktop session %s ended: %s", sessionID, reason)

	if g.auditLog != nil {
		g.auditLog.Log("cdap_desktop_ended", ds.deviceConn.ClientIP, ds.Username, map[string]string{
			"session_id": sessionID,
			"device_id":  ds.DeviceID,
			"reason":     reason,
		})
	}
}
