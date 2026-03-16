/**
 * BetterDesk Console - Remote Desktop Viewer Page Controller
 * Initializes RDClient and manages the viewer UI interactions
 */

/* global RDClient, RDVideo */

(function () {
    'use strict';

    // ---- DOM References ----
    const viewerContainer = document.getElementById('viewer-container');
    const canvas = document.getElementById('remote-canvas');
    const connectionOverlay = document.getElementById('connection-overlay');
    const passwordOverlay = document.getElementById('password-overlay');
    const statusText = document.getElementById('status-text');
    const overlayActions = document.getElementById('overlay-actions');
    const passwordInput = document.getElementById('device-password');
    const loginError = document.getElementById('login-error');
    const toolbarStatus = document.getElementById('toolbar-status');
    const toolbarStats = document.getElementById('toolbar-stats');
    const toolbar = document.getElementById('viewer-toolbar');

    // Extract device ID from URL
    const pathParts = window.location.pathname.split('/');
    const deviceId = pathParts[pathParts.length - 1];

    if (!deviceId) {
        window.location.href = '/devices';
        return;
    }

    // ---- Client Instance ----
    let client = null;

    // ---- Auto-hide toolbar ----
    let toolbarTimeout = null;
    let toolbarVisible = true;
    let toolbarPinned = false;

    function showToolbar() {
        toolbar.classList.add('visible');
        toolbarVisible = true;
        clearTimeout(toolbarTimeout);
        if (!toolbarPinned) {
            toolbarTimeout = setTimeout(hideToolbar, 3000);
        }
    }

    function hideToolbar() {
        if (toolbarPinned) return;
        if (client && client.state === 'streaming') {
            toolbar.classList.remove('visible');
            toolbarVisible = false;
        }
    }

    // Show toolbar on mouse move near top
    viewerContainer.addEventListener('mousemove', (e) => {
        if (e.clientY < 60 || toolbarVisible) {
            showToolbar();
        }
    });

    // Always show toolbar when not streaming
    function setToolbarAutoHide(enable) {
        if (enable) {
            showToolbar();
        } else {
            clearTimeout(toolbarTimeout);
            toolbar.classList.add('visible');
            toolbarVisible = true;
        }
    }

    // ---- Initialize ----

    async function init() {
        // Show warning if WebCodecs not available (requires HTTPS or localhost)
        if (!RDVideo.isSupported()) {
            const isInsecure = window.location.protocol === 'http:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1';
            if (isInsecure) {
                console.warn('[Remote] WebCodecs unavailable: insecure context (HTTP). Video will use software fallback.');
            } else {
                console.warn('[Remote] WebCodecs unavailable. Video will use software fallback.');
            }
        }

        // Create client instance
        client = new RDClient(canvas, {
            deviceId: deviceId,
            serverPubKey: window.BetterDesk.serverPubKey || '',
            scaleMode: 'fit',
            fps: 60,
            disableAudio: false
        });

        // Wire up events
        client.on('state', handleStateChange);
        client.on('log', handleLog);
        client.on('error', handleError);
        client.on('disconnected', handleDisconnected);
        client.on('password_required', showPasswordPrompt);
        client.on('login_error', handleLoginError);
        client.on('login_success', handleLoginSuccess);
        client.on('session_start', handleSessionStart);
        client.on('stats', updateStats);
        client.on('latency', updateLatency);

        // Chat messages from remote
        client.on('chat', (text) => addChatMessage(text, 'received'));

        // Handle window resize
        window.addEventListener('resize', () => {
            if (client && client.renderer) {
                client.renderer.resize();
            }
        });

        // Initial canvas resize
        client.renderer.resize();

        // Start connection
        try {
            await client.connect();
        } catch (err) {
            setStatus('error', err.message);
            showOverlayActions();
        }
    }

    // ---- Event Handlers ----

    function handleStateChange(state, prev) {
        const stateLabels = {
            'idle': _('remote.status_idle'),
            'connecting': _('remote.connecting'),
            'waiting_password': _('remote.waiting_password'),
            'authenticating': _('remote.authenticating'),
            'streaming': _('remote.streaming'),
            'disconnected': _('remote.disconnected'),
            'error': _('remote.error')
        };

        const label = stateLabels[state] || state;
        toolbarStatus.textContent = label;

        switch (state) {
        case 'connecting':
            showConnectionOverlay();
            setStatus('loading', label);
            setToolbarAutoHide(false);
            break;

        case 'waiting_password':
            // Handled by password_required event
            break;

        case 'authenticating':
            setStatus('loading', label);
            break;

        case 'streaming':
            hideOverlays();
            viewerContainer.classList.add('streaming');
            setToolbarAutoHide(true);
            break;

        case 'disconnected':
        case 'error':
            viewerContainer.classList.remove('streaming');
            showConnectionOverlay();
            setStatus(state === 'error' ? 'error' : 'info', label);
            showOverlayActions();
            setToolbarAutoHide(false);
            break;
        }
    }

    function handleLog(message) {
        console.log('[Remote]', message);
        // Update status text with latest log
        if (client && (client.state === 'connecting' || client.state === 'authenticating')) {
            statusText.textContent = message;
        }
    }

    function handleError(message) {
        console.error('[Remote]', message);
        setStatus('error', message);
        showOverlayActions();
    }

    function handleDisconnected(reason) {
        setStatus('info', reason || _('remote.disconnected'));
        showOverlayActions();
        setToolbarAutoHide(false);
    }

    function showPasswordPrompt() {
        connectionOverlay.style.display = 'none';
        passwordOverlay.style.display = 'flex';
        loginError.style.display = 'none';
        passwordInput.value = '';
        passwordInput.focus();
    }

    function handleLoginError(error) {
        loginError.textContent = error;
        loginError.style.display = 'block';
        passwordInput.value = '';
        passwordInput.focus();
    }

    function handleLoginSuccess() {
        passwordOverlay.style.display = 'none';
        // Remove focus from password input so keyboard events reach the canvas
        passwordInput.blur();
    }

    function handleSessionStart() {
        hideOverlays();
        client.renderer.resize();

        // Explicitly focus canvas so mouse/keyboard events are captured
        canvas.focus();

        // Wire up autoplay-blocked callback from video decoder (JMuxer fallback)
        if (client.video) {
            client.video.onAutoplayBlocked = () => {
                showAutoplayOverlay();
            };
        }
    }

    // ---- Autoplay Blocked Overlay ----

    function showAutoplayOverlay() {
        let overlay = document.getElementById('autoplay-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'autoplay-overlay';
            overlay.className = 'viewer-overlay autoplay-overlay';
            overlay.innerHTML = `
                <div class="overlay-card autoplay-card">
                    <div class="overlay-icon">
                        <span class="material-icons">play_circle</span>
                    </div>
                    <h2 class="overlay-title">${_('remote.click_to_start') || 'Click to Start'}</h2>
                    <p class="overlay-hint">${_('remote.autoplay_blocked') || 'Browser requires user interaction to start video and audio playback.'}</p>
                    <button class="btn btn-primary btn-full" id="btn-autoplay-start">
                        <span class="material-icons">play_arrow</span>
                        ${_('remote.start_playback') || 'Start Playback'}
                    </button>
                </div>
            `;
            viewerContainer.appendChild(overlay);
        }
        overlay.style.display = 'flex';

        const startBtn = document.getElementById('btn-autoplay-start');
        if (startBtn) {
            startBtn.addEventListener('click', () => {
                overlay.style.display = 'none';
                if (client && client.video) {
                    client.video.retryPlay();
                }
                // Also try to resume audio context
                if (client && client.audio && client.audio.audioCtx && client.audio.audioCtx.state === 'suspended') {
                    client.audio.audioCtx.resume();
                }
            }, { once: true });
        }

        // Also allow clicking anywhere on the overlay
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.style.display = 'none';
                if (client && client.video) {
                    client.video.retryPlay();
                }
                if (client && client.audio && client.audio.audioCtx && client.audio.audioCtx.state === 'suspended') {
                    client.audio.audioCtx.resume();
                }
            }
        }, { once: true });
    }

    let lastLatency = 0;
    function updateLatency(rtt) {
        lastLatency = rtt;
    }

    function updateStats(stats) {
        if (!stats) return;
        const parts = [];
        // Show actual video FPS from peer (not renderer RAF rate)
        if (stats.video) {
            const fps = stats.video.videoFps || 0;
            parts.push(`${fps} FPS`);
            // Show total frames for diagnostics
            if (stats.video.frameCount !== undefined) {
                parts.push(`${stats.video.frameCount} frames`);
            }
        }
        if (stats.video && stats.video.displayWidth && stats.video.displayHeight) {
            parts.push(`${stats.video.displayWidth}x${stats.video.displayHeight}`);
        } else if (stats.renderer && stats.renderer.remoteWidth && stats.renderer.remoteHeight) {
            parts.push(`${stats.renderer.remoteWidth}x${stats.renderer.remoteHeight}`);
        }
        if (lastLatency > 0) {
            parts.push(`${lastLatency}ms`);
        }
        if (stats.video && stats.video.codec) {
            parts.push(stats.video.codec.toUpperCase());
        }
        toolbarStats.textContent = parts.join(' | ');
    }

    // ---- UI Helpers ----

    function showConnectionOverlay() {
        connectionOverlay.style.display = 'flex';
        passwordOverlay.style.display = 'none';
        overlayActions.style.display = 'none';
    }

    function hideOverlays() {
        connectionOverlay.style.display = 'none';
        passwordOverlay.style.display = 'none';
    }

    function showOverlayActions() {
        overlayActions.style.display = 'flex';
        const spinner = connectionOverlay.querySelector('.spinner');
        if (spinner) spinner.style.display = 'none';
    }

    function setStatus(type, text) {
        statusText.textContent = text;
        const statusEl = document.getElementById('connection-status');
        statusEl.className = 'overlay-status ' + type;
    }

    // ---- Toolbar Button Handlers ----

    // Reconnect
    document.getElementById('btn-reconnect')?.addEventListener('click', () => {
        if (client) {
            client.disconnect();
        }
        overlayActions.style.display = 'none';
        const spinner = connectionOverlay.querySelector('.spinner');
        if (spinner) spinner.style.display = 'block';
        init();
    });

    // Authenticate
    document.getElementById('btn-authenticate')?.addEventListener('click', () => {
        const password = passwordInput.value;
        if (!password) {
            passwordInput.focus();
            return;
        }
        if (client) {
            client.authenticate(password);
        }
    });

    // Password input enter key
    passwordInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            document.getElementById('btn-authenticate')?.click();
        }
    });

    // Fullscreen
    document.getElementById('btn-fullscreen')?.addEventListener('click', () => {
        if (client) {
            client.toggleFullscreen(viewerContainer);
        }
    });

    // Disconnect
    document.getElementById('btn-disconnect')?.addEventListener('click', () => {
        if (client) {
            client.disconnect();
        }
    });

    // Audio toggle
    let audioMuted = false;
    document.getElementById('btn-audio')?.addEventListener('click', function () {
        audioMuted = !audioMuted;
        if (client) {
            client.setAudioMuted(audioMuted);
        }
        this.querySelector('.material-icons').textContent =
            audioMuted ? 'volume_off' : 'volume_up';
    });

    // Ctrl+Alt+Del
    document.getElementById('btn-cad')?.addEventListener('click', () => {
        if (client) client.sendCtrlAltDel();
    });

    // Lock Screen
    document.getElementById('btn-lock')?.addEventListener('click', () => {
        if (client) client.sendLockScreen();
    });

    // Restart Remote Device
    document.getElementById('btn-restart-remote')?.addEventListener('click', () => {
        if (client && confirm(_('remote.confirm_restart'))) {
            client.sendRestartRemoteDevice();
        }
    });

    // Refresh Screen
    document.getElementById('btn-refresh-screen')?.addEventListener('click', () => {
        if (client) client.sendRefreshScreen();
    });

    // Clipboard Paste
    document.getElementById('btn-clipboard-paste')?.addEventListener('click', async () => {
        if (!client) return;
        try {
            const text = await navigator.clipboard.readText();
            if (text) client.sendClipboard(text);
        } catch {
            // Clipboard read permission denied
        }
    });

    // Block Input toggle
    setupToggle('btn-block-input', (on) => { if (client) client.setBlockInput(on); });

    // Image Quality items
    document.querySelectorAll('.quality-item').forEach(btn => {
        btn.addEventListener('click', function () {
            const quality = this.dataset.quality;
            if (client) client.setImageQuality(quality);
            document.querySelectorAll('.quality-item').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
        });
    });

    // Scale Mode items
    document.querySelectorAll('.scale-item').forEach(btn => {
        btn.addEventListener('click', function () {
            const mode = this.dataset.scale;
            if (client) client.setScaleMode(mode);
            document.querySelectorAll('.scale-item').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
        });
    });

    // Show Remote Cursor toggle
    setupToggle('btn-show-cursor', (on) => { if (client) client.setShowRemoteCursor(on); });

    // Lock After Session toggle
    setupToggle('btn-lock-session', (on) => { if (client) client.setLockAfterSession(on); });

    // Privacy Mode toggle
    setupToggle('btn-privacy-mode', (on) => { if (client) client.setPrivacyMode(on); });

    // Disable Clipboard toggle
    setupToggle('btn-disable-clipboard', (on) => { if (client) client.setDisableClipboard(on); });

    // Actions dropdown
    document.getElementById('btn-actions')?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllDropdowns('actions-menu');
        document.getElementById('actions-menu')?.classList.toggle('open');
    });

    // Display dropdown
    document.getElementById('btn-display')?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllDropdowns('display-menu');
        document.getElementById('display-menu')?.classList.toggle('open');
    });

    /** Close all dropdowns except the one with given ID */
    function closeAllDropdowns(exceptId) {
        document.querySelectorAll('.toolbar-dropdown-menu.open').forEach(m => {
            if (m.id !== exceptId) m.classList.remove('open');
        });
    }

    /** Setup toggle button helper */
    function setupToggle(btnId, onChange) {
        document.getElementById(btnId)?.addEventListener('click', function () {
            const active = this.dataset.active !== 'true';
            this.dataset.active = active.toString();
            onChange(active);
        });
    }

    // View Only toggle
    document.getElementById('btn-viewonly')?.addEventListener('click', function () {
        const isViewOnly = !this.classList.contains('active');
        this.classList.toggle('active', isViewOnly);
        if (client) client.setViewOnly(isViewOnly);
    });

    // Pin Toolbar toggle
    document.getElementById('btn-pin')?.addEventListener('click', function () {
        toolbarPinned = !toolbarPinned;
        toolbar.classList.toggle('pinned', toolbarPinned);
        this.classList.toggle('active', toolbarPinned);
        if (toolbarPinned) {
            clearTimeout(toolbarTimeout);
        }
    });

    // Recording
    let mediaRecorder = null;
    let recordedChunks = [];

    document.getElementById('btn-record')?.addEventListener('click', function () {
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
            this.classList.remove('recording');
        } else {
            try {
                const stream = canvas.captureStream(30);
                recordedChunks = [];
                const mimeTypes = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
                let mimeType = '';
                for (const mt of mimeTypes) {
                    if (MediaRecorder.isTypeSupported(mt)) { mimeType = mt; break; }
                }
                mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
                mediaRecorder.ondataavailable = (e) => {
                    if (e.data.size > 0) recordedChunks.push(e.data);
                };
                mediaRecorder.onstop = () => {
                    const blob = new Blob(recordedChunks, { type: mimeType || 'video/webm' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'betterdesk-recording-' + Date.now() + '.webm';
                    a.click();
                    URL.revokeObjectURL(url);
                    mediaRecorder = null;
                };
                mediaRecorder.start(1000);
                this.classList.add('recording');
            } catch (err) {
                console.warn('[Remote] Recording not supported:', err);
            }
        }
    });

    // Chat panel
    const chatPanel = document.getElementById('chat-panel');
    const chatMessages = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input');

    document.getElementById('btn-chat')?.addEventListener('click', function () {
        const isOpen = chatPanel.style.display !== 'none';
        chatPanel.style.display = isOpen ? 'none' : 'flex';
        this.classList.toggle('active', !isOpen);
        if (!isOpen && chatInput) chatInput.focus();
    });

    document.getElementById('btn-chat-close')?.addEventListener('click', () => {
        chatPanel.style.display = 'none';
        document.getElementById('btn-chat')?.classList.remove('active');
    });

    document.getElementById('btn-chat-send')?.addEventListener('click', sendChatMessage);

    chatInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendChatMessage();
        e.stopPropagation(); // Don't forward to remote
    });

    function sendChatMessage() {
        const text = chatInput?.value?.trim();
        if (!text || !client) return;
        client.sendChat(text);
        addChatMessage(text, 'sent');
        chatInput.value = '';
    }

    function addChatMessage(text, type) {
        const div = document.createElement('div');
        div.className = 'chat-msg ' + type;
        div.textContent = text;
        chatMessages?.appendChild(div);
        if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    // Close dropdowns on outside click
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.toolbar-dropdown')) {
            document.querySelectorAll('.toolbar-dropdown-menu.open').forEach(m => m.classList.remove('open'));
        }
    });

    // Fullscreen change handler
    document.addEventListener('fullscreenchange', () => {
        const icon = document.getElementById('btn-fullscreen')?.querySelector('.material-icons');
        if (icon) {
            icon.textContent = document.fullscreenElement ? 'fullscreen_exit' : 'fullscreen';
        }
        setTimeout(() => {
            if (client && client.renderer) client.renderer.resize();
        }, 100);
    });

    // Keyboard shortcut: Escape to show toolbar / exit fullscreen
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !document.fullscreenElement) {
            showToolbar();
        }
    });

    // ---- Global translation helper (if not available) ----
    if (typeof window._ === 'undefined') {
        window._ = function (key) {
            const parts = key.split('.');
            let val = window.BetterDesk?.translations;
            for (const p of parts) {
                if (!val) return key;
                val = val[p];
            }
            return val || key;
        };
    }

    // ---- Start ----
    init();
})();
