/**
 * BetterDesk Console — CDAP Remote Desktop Widget
 * Provides interactive remote desktop access to CDAP devices via WebSocket.
 * Renders screen frames on canvas and relays mouse/keyboard input.
 * Supports: clipboard sync, custom cursors, quality reporting, codec
 * negotiation, multi-monitor selection, and keyframe requests.
 */

(function () {
    'use strict';

    const activeSessions = {};

    // ── Mouse encoding (matching RustDesk mask format) ───────────────────

    const MOUSE_TYPE_DOWN  = 1;
    const MOUSE_TYPE_UP    = 2;
    const MOUSE_TYPE_MOVE  = 0;
    const MOUSE_TYPE_WHEEL = 3;

    const MOUSE_BUTTON_LEFT   = 1;
    const MOUSE_BUTTON_RIGHT  = 2;
    const MOUSE_BUTTON_MIDDLE = 4;

    // Quality reporting interval (ms)
    const QUALITY_REPORT_INTERVAL = 5000;
    // Cursor cache limit
    const CURSOR_CACHE_MAX = 50;

    // ── Desktop Session Manager ──────────────────────────────────────────

    function openDesktop(deviceId, widgetId) {
        const key = `${deviceId}:${widgetId}`;
        if (activeSessions[key]) return;

        const widgetEl = document.getElementById(`wval-${CSS.escape(widgetId)}`);
        if (!widgetEl) return;

        const canvas = widgetEl.querySelector('.cdap-desktop-canvas');
        const overlay = widgetEl.querySelector('.cdap-desktop-overlay');
        if (!canvas) return;

        const ctx = canvas.getContext('2d');

        // Show connecting state
        if (overlay) {
            overlay.querySelector('span:last-child').textContent = 'Connecting...';
        }

        // Open WebSocket
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${proto}//${window.location.host}/api/cdap/devices/${encodeURIComponent(deviceId)}/desktop`;
        let ws;
        try {
            ws = new WebSocket(wsUrl, ['cdap-desktop']);
        } catch (err) {
            console.error('[CDAPDesktop] WS creation failed:', err);
            return;
        }

        const session = {
            ws,
            canvas,
            ctx,
            overlay,
            widgetEl,
            widgetId,
            deviceId,
            sessionId: null,
            connected: false,
            width: 1280,
            height: 720,
            _frameImg: new Image(),
            // Quality reporting
            _frameCount: 0,
            _frameBytes: 0,
            _lastFrameTime: 0,
            _droppedFrames: 0,
            _qualityTimer: null,
            // Custom cursor
            _cursorCache: {},
            _cursorCacheKeys: [],
            // Monitor list
            _monitors: [],
            _activeMonitor: 0,
            // Codec
            _videoCodec: null,
            _audioCodec: null,
            // Clipboard
            _clipboardEnabled: true
        };
        activeSessions[key] = session;

        ws.onopen = () => {
            // Send init message with desired resolution
            ws.send(JSON.stringify({
                width: session.width,
                height: session.height,
                quality: 70,
                fps: 15
            }));
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                handleMessage(session, msg);
            } catch (_) {
                // Ignore non-JSON
            }
        };

        ws.onerror = () => {
            console.error('[CDAPDesktop] WS error for', deviceId);
        };

        ws.onclose = () => {
            if (activeSessions[key]) {
                setDisconnected(session);
                delete activeSessions[key];
            }
        };

        // Bind input events
        bindInputEvents(session);
    }

    function handleMessage(session, msg) {
        switch (msg.type) {
            case 'ready':
                session.sessionId = msg.session_id;
                session.connected = true;
                // Hide overlay
                if (session.overlay) {
                    session.overlay.classList.add('hidden');
                }
                // Start quality reporting
                startQualityReporting(session);
                // Send codec offer
                sendCodecOffer(session);
                break;

            case 'frame':
                renderFrame(session, msg);
                break;

            case 'cursor_update':
                applyCursor(session, msg);
                break;

            case 'clipboard_update':
                handleClipboardUpdate(session, msg);
                break;

            case 'codec_answer':
                session._videoCodec = msg.video_codec || null;
                session._audioCodec = msg.audio_codec || null;
                break;

            case 'monitor_list':
                handleMonitorList(session, msg);
                break;

            case 'quality_adjust':
                // Server-initiated quality change — informational only
                break;

            case 'error':
                console.error('[CDAPDesktop] Error:', msg.error);
                break;

            case 'end':
                setDisconnected(session);
                closeDesktop(session.deviceId, session.widgetId);
                break;
        }
    }

    // ── Frame Rendering ──────────────────────────────────────────────────

    function renderFrame(session, msg) {
        if (!msg.data) return;

        const { canvas, ctx, _frameImg } = session;
        const format = msg.format || 'jpeg';

        // Track quality stats
        session._frameCount++;
        session._frameBytes += msg.data.length * 0.75; // approximate decoded size
        session._lastFrameTime = Date.now();

        // Resize canvas if frame dimensions changed
        if (msg.width && msg.height) {
            if (canvas.width !== msg.width || canvas.height !== msg.height) {
                canvas.width = msg.width;
                canvas.height = msg.height;
            }
        }

        // Render base64-encoded frame
        const src = `data:image/${format};base64,${msg.data}`;
        const img = _frameImg;
        img.onload = () => {
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        };
        img.onerror = () => {
            session._droppedFrames++;
        };
        img.src = src;
    }

    // ── Custom Cursor ────────────────────────────────────────────────────

    function applyCursor(session, msg) {
        const { canvas } = session;

        // Hidden cursor
        if (msg.hidden) {
            canvas.style.cursor = 'none';
            return;
        }

        // Check cache
        if (msg.cursor_id && session._cursorCache[msg.cursor_id]) {
            canvas.style.cursor = session._cursorCache[msg.cursor_id];
            return;
        }

        if (!msg.data || !msg.width || !msg.height) {
            canvas.style.cursor = 'default';
            return;
        }

        const hotX = msg.hotspot_x || 0;
        const hotY = msg.hotspot_y || 0;
        const format = msg.format || 'png';

        if (format === 'png') {
            const cursorUrl = `url(data:image/png;base64,${msg.data}) ${hotX} ${hotY}, auto`;
            canvas.style.cursor = cursorUrl;
            cacheCursor(session, msg.cursor_id, cursorUrl);
        } else if (format === 'rgba') {
            // Convert raw RGBA to canvas → PNG data URL
            try {
                const w = msg.width;
                const h = msg.height;
                const raw = atob(msg.data);
                if (raw.length !== w * h * 4) {
                    canvas.style.cursor = 'default';
                    return;
                }
                const bytes = new Uint8ClampedArray(raw.length);
                for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
                const imgData = new ImageData(bytes, w, h);
                const tmpCanvas = document.createElement('canvas');
                tmpCanvas.width = w;
                tmpCanvas.height = h;
                tmpCanvas.getContext('2d').putImageData(imgData, 0, 0);
                const dataUrl = tmpCanvas.toDataURL('image/png');
                const cursorUrl = `url(${dataUrl}) ${hotX} ${hotY}, auto`;
                canvas.style.cursor = cursorUrl;
                cacheCursor(session, msg.cursor_id, cursorUrl);
            } catch (_) {
                canvas.style.cursor = 'default';
            }
        }
    }

    function cacheCursor(session, cursorId, cursorUrl) {
        if (!cursorId) return;
        session._cursorCache[cursorId] = cursorUrl;
        session._cursorCacheKeys.push(cursorId);
        // Evict old entries
        while (session._cursorCacheKeys.length > CURSOR_CACHE_MAX) {
            const old = session._cursorCacheKeys.shift();
            delete session._cursorCache[old];
        }
    }

    // ── Clipboard Sync ───────────────────────────────────────────────────

    function handleClipboardUpdate(session, msg) {
        if (!session._clipboardEnabled || !msg.data) return;

        // Write to browser clipboard if Clipboard API available
        if (navigator.clipboard && navigator.clipboard.writeText && msg.format === 'text') {
            navigator.clipboard.writeText(msg.data).catch(() => {
                // Permission denied or not focused
            });
        }

        // Show clipboard indicator
        showClipboardIndicator(session, 'in');
    }

    function sendClipboard(session, text) {
        if (!session.connected || !session._clipboardEnabled || !text) return;
        sendMsg(session, {
            type: 'clipboard_set',
            format: 'text',
            data: text
        });
        showClipboardIndicator(session, 'out');
    }

    function showClipboardIndicator(session, direction) {
        const indicator = session.widgetEl?.querySelector('.cdap-desktop-clipboard-indicator');
        if (!indicator) return;
        indicator.classList.remove('hidden', 'clip-in', 'clip-out');
        indicator.classList.add(direction === 'in' ? 'clip-in' : 'clip-out');
        indicator.textContent = direction === 'in' ? '\u2193 Clipboard' : '\u2191 Clipboard';
        setTimeout(() => indicator.classList.add('hidden'), 1500);
    }

    // ── Quality Reporting ────────────────────────────────────────────────

    function startQualityReporting(session) {
        if (session._qualityTimer) clearInterval(session._qualityTimer);
        session._qrPrevFrames = 0;
        session._qrPrevBytes = 0;
        session._qrPrevDropped = 0;
        session._qrPrevTime = Date.now();

        session._qualityTimer = setInterval(() => sendQualityReport(session), QUALITY_REPORT_INTERVAL);
    }

    function sendQualityReport(session) {
        if (!session.connected || !session.sessionId) return;

        const now = Date.now();
        const elapsed = (now - session._qrPrevTime) / 1000;
        if (elapsed <= 0) return;

        const frames = session._frameCount - session._qrPrevFrames;
        const bytes = session._frameBytes - session._qrPrevBytes;
        const dropped = session._droppedFrames - session._qrPrevDropped;
        const fps = Math.round(frames / elapsed);
        const bandwidthKB = bytes / 1024 / elapsed;
        const frameLoss = frames > 0 ? dropped / (frames + dropped) : 0;

        // Estimate latency from frame timestamps (rough)
        const latencyMs = session._lastFrameTime > 0
            ? Math.max(0, now - session._lastFrameTime)
            : 0;

        sendMsg(session, {
            type: 'quality_report',
            session_id: session.sessionId,
            bandwidth_kb: Math.round(bandwidthKB * 10) / 10,
            latency_ms: latencyMs,
            frame_loss: Math.round(frameLoss * 1000) / 1000,
            fps: fps
        });

        session._qrPrevFrames = session._frameCount;
        session._qrPrevBytes = session._frameBytes;
        session._qrPrevDropped = session._droppedFrames;
        session._qrPrevTime = now;
    }

    // ── Codec Negotiation ────────────────────────────────────────────────

    function sendCodecOffer(session) {
        if (!session.sessionId) return;
        sendMsg(session, {
            type: 'codec_offer',
            session_id: session.sessionId,
            video: ['jpeg', 'png'],
            audio: ['opus', 'pcm'],
            preferred: 'jpeg'
        });
    }

    // ── Multi-Monitor ────────────────────────────────────────────────────

    function handleMonitorList(session, msg) {
        session._monitors = msg.monitors || [];
        session._activeMonitor = typeof msg.active === 'number' ? msg.active : 0;

        // Render monitor selector in toolbar
        const toolbar = session.widgetEl?.querySelector('.cdap-desktop-toolbar');
        if (!toolbar || session._monitors.length <= 1) return;

        let selectorEl = toolbar.querySelector('.cdap-monitor-selector');
        if (!selectorEl) {
            selectorEl = document.createElement('div');
            selectorEl.className = 'cdap-monitor-selector';
            toolbar.appendChild(selectorEl);
        }

        let html = '<span class="material-icons">monitor</span><select class="cdap-monitor-select">';
        for (const mon of session._monitors) {
            const label = mon.name || `Monitor ${mon.index + 1}`;
            const dims = `${mon.width}x${mon.height}`;
            const primary = mon.primary ? ' *' : '';
            const selected = mon.index === session._activeMonitor ? ' selected' : '';
            html += `<option value="${mon.index}"${selected}>${label} (${dims})${primary}</option>`;
        }
        html += '</select>';
        selectorEl.innerHTML = html;

        // Bind change event
        const select = selectorEl.querySelector('select');
        select.addEventListener('change', () => {
            const idx = parseInt(select.value, 10);
            selectMonitor(session, idx);
        });
    }

    function selectMonitor(session, index) {
        if (!session.connected || !session.sessionId) return;
        session._activeMonitor = index;
        sendMsg(session, {
            type: 'monitor_select',
            session_id: session.sessionId,
            index: index
        });
    }

    // ── Keyframe Request ─────────────────────────────────────────────────

    function requestKeyframe(deviceId, widgetId) {
        const key = `${deviceId}:${widgetId}`;
        const session = activeSessions[key];
        if (!session || !session.connected || !session.sessionId) return;
        sendMsg(session, {
            type: 'keyframe_request',
            session_id: session.sessionId
        });
    }

    // ── Input Events ─────────────────────────────────────────────────────

    function bindInputEvents(session) {
        const { canvas, ws } = session;

        // Mouse events
        canvas.addEventListener('mousedown', (e) => {
            if (!session.connected) return;
            sendMouseEvent(session, e, MOUSE_TYPE_DOWN);
            e.preventDefault();
        });

        canvas.addEventListener('mouseup', (e) => {
            if (!session.connected) return;
            sendMouseEvent(session, e, MOUSE_TYPE_UP);
            e.preventDefault();
        });

        canvas.addEventListener('mousemove', (e) => {
            if (!session.connected) return;
            sendMouseEvent(session, e, MOUSE_TYPE_MOVE);
        });

        canvas.addEventListener('wheel', (e) => {
            if (!session.connected) return;
            const rect = canvas.getBoundingClientRect();
            const x = Math.round((e.clientX - rect.left) / rect.width * canvas.width);
            const y = Math.round((e.clientY - rect.top) / rect.height * canvas.height);
            sendInput(session, {
                type: 'input',
                input_type: 'mouse',
                x, y,
                deltaX: e.deltaX,
                deltaY: e.deltaY,
                button: MOUSE_TYPE_WHEEL
            });
            e.preventDefault();
        }, { passive: false });

        canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        // Keyboard events
        canvas.setAttribute('tabindex', '0');

        canvas.addEventListener('keydown', (e) => {
            if (!session.connected) return;
            sendKeyEvent(session, e, 'keydown');
            e.preventDefault();
        });

        canvas.addEventListener('keyup', (e) => {
            if (!session.connected) return;
            sendKeyEvent(session, e, 'keyup');
            e.preventDefault();
        });

        // Clipboard paste (Ctrl+V / Cmd+V)
        canvas.addEventListener('paste', (e) => {
            if (!session.connected || !session._clipboardEnabled) return;
            const text = e.clipboardData?.getData('text/plain');
            if (text) sendClipboard(session, text);
            e.preventDefault();
        });

        // Clipboard copy (Ctrl+C / Cmd+C) — read from navigator.clipboard
        canvas.addEventListener('copy', (e) => {
            // Default browser copy is fine; clipboard_update from device handles inbound
            e.preventDefault();
        });

        // Focus canvas for keyboard input
        canvas.focus();
    }

    function sendMouseEvent(session, e, mouseType) {
        const { canvas } = session;
        const rect = canvas.getBoundingClientRect();
        const x = Math.round((e.clientX - rect.left) / rect.width * canvas.width);
        const y = Math.round((e.clientY - rect.top) / rect.height * canvas.height);

        let button = 0;
        if (e.button === 0) button = MOUSE_BUTTON_LEFT;
        else if (e.button === 2) button = MOUSE_BUTTON_RIGHT;
        else if (e.button === 1) button = MOUSE_BUTTON_MIDDLE;

        sendInput(session, {
            type: 'input',
            input_type: 'mouse',
            x, y,
            button: mouseType | (button << 3)
        });
    }

    function sendKeyEvent(session, e, eventType) {
        sendInput(session, {
            type: 'input',
            input_type: 'keyboard',
            key: e.key,
            code: e.code,
            modifiers: {
                ctrl: e.ctrlKey,
                alt: e.altKey,
                shift: e.shiftKey,
                meta: e.metaKey
            },
            down: eventType === 'keydown'
        });
    }

    function sendInput(session, payload) {
        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(JSON.stringify(payload));
        }
    }

    function sendMsg(session, payload) {
        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(JSON.stringify(payload));
        }
    }

    // ── Disconnect / Cleanup ─────────────────────────────────────────────

    function setDisconnected(session) {
        session.connected = false;
        if (session._qualityTimer) {
            clearInterval(session._qualityTimer);
            session._qualityTimer = null;
        }
        if (session.overlay) {
            session.overlay.classList.remove('hidden');
            session.overlay.querySelector('span:last-child').textContent =
                window.BetterDesk?.t?.('cdap.disconnected') || 'Disconnected';
        }
        // Reset cursor
        if (session.canvas) session.canvas.style.cursor = 'default';
        // Show connect button again
        const connectDiv = session.widgetEl?.querySelector('.cdap-desktop-connect');
        if (connectDiv) connectDiv.classList.remove('hidden');
    }

    function closeDesktop(deviceId, widgetId) {
        const key = `${deviceId}:${widgetId}`;
        const session = activeSessions[key];
        if (!session) return;

        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(JSON.stringify({ type: 'close' }));
            session.ws.close();
        }
        setDisconnected(session);
        delete activeSessions[key];
    }

    // ── Public API ───────────────────────────────────────────────────────

    window.CDAPDesktop = {
        open: openDesktop,
        close: closeDesktop,
        isActive: (deviceId, widgetId) => !!activeSessions[`${deviceId}:${widgetId}`],
        requestKeyframe: requestKeyframe,
        selectMonitor: (deviceId, widgetId, index) => {
            const s = activeSessions[`${deviceId}:${widgetId}`];
            if (s) selectMonitor(s, index);
        },
        getMonitors: (deviceId, widgetId) => {
            const s = activeSessions[`${deviceId}:${widgetId}`];
            return s ? { monitors: s._monitors, active: s._activeMonitor } : null;
        },
        setClipboardEnabled: (deviceId, widgetId, enabled) => {
            const s = activeSessions[`${deviceId}:${widgetId}`];
            if (s) s._clipboardEnabled = !!enabled;
        }
    };

})();
