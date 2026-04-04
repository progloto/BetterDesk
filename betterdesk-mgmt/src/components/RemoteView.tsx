/**
 * RemoteView — remote desktop viewer with live JPEG stream + mouse/keyboard input
 *
 * Uses `start_remote_viewer` Tauri IPC (WS management endpoint) for video,
 * and `send_remote_input` for mouse/keyboard forwarding.
 */
import { createSignal, onMount, onCleanup, Show } from 'solid-js';
import { t } from '../lib/i18n';
import { getDevice, type Device } from '../lib/api';
import { toastError, toastInfo } from '../stores/toast';

interface RemoteViewProps {
    deviceId: string;
    onDisconnect: () => void;
}

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

export default function RemoteView(props: RemoteViewProps) {
    const [state, setState] = createSignal<ConnectionState>('connecting');
    const [device, setDevice] = createSignal<Device | null>(null);
    const [errorMsg, setErrorMsg] = createSignal('');
    const [fps, setFps] = createSignal(0);
    const [latency, setLatency] = createSignal(0);
    const [isFullscreen, setIsFullscreen] = createSignal(false);
    let canvasRef: HTMLCanvasElement | undefined;
    let containerRef: HTMLDivElement | undefined;
    let frameUnlisten: (() => void) | undefined;
    let statusUnlisten: (() => void) | undefined;
    let fpsCounter = 0;
    let fpsInterval: ReturnType<typeof setInterval> | undefined;
    let lastFrameTime = 0;

    onMount(async () => {
        try {
            const d = await getDevice(props.deviceId);
            setDevice(d);
            if (!d.online && d.status !== 'online') {
                setState('error');
                setErrorMsg(t('remote.device_offline'));
                return;
            }
            await startConnection();
        } catch {
            setState('error');
            setErrorMsg(t('remote.connect_failed'));
        }
    });

    onCleanup(() => {
        disconnect();
        if (fpsInterval) clearInterval(fpsInterval);
    });

    async function startConnection() {
        setState('connecting');
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const { listen } = await import('@tauri-apps/api/event');

            // Listen for JPEG frames (base64 encoded)
            frameUnlisten = await listen<string>('remote-viewer-frame', (event) => {
                if (!canvasRef) return;
                const now = performance.now();
                if (lastFrameTime > 0) {
                    setLatency(Math.round(now - lastFrameTime));
                }
                lastFrameTime = now;
                fpsCounter++;
                renderFrame(event.payload);
            });

            // Listen for status changes
            statusUnlisten = await listen<{ status: string; message?: string }>('remote-viewer-status', (event) => {
                const { status, message } = event.payload;
                if (status === 'connected') {
                    setState('connected');
                } else if (status === 'disconnected' || status === 'error') {
                    setState(status === 'error' ? 'error' : 'disconnected');
                    if (message) setErrorMsg(message);
                }
            });

            // FPS counter — update every second
            fpsInterval = setInterval(() => {
                setFps(fpsCounter);
                fpsCounter = 0;
            }, 1000);

            // Start the WS viewer (sends JPEG frames via events)
            await invoke('start_remote_viewer', {
                deviceId: props.deviceId,
                serverUrl: localStorage.getItem('bd_mgmt_server_url') || '',
            });
            setState('connected');
            toastInfo(t('remote.connected'), props.deviceId);

            // Focus canvas for keyboard input
            setTimeout(() => canvasRef?.focus(), 100);
        } catch (err: unknown) {
            setState('error');
            const msg = err instanceof Error ? err.message : String(err);
            setErrorMsg(msg || t('remote.connect_failed'));
            toastError(t('remote.connect_failed'), msg);
        }
    }

    function renderFrame(base64: string) {
        if (!canvasRef) return;
        const img = new Image();
        img.onload = () => {
            const ctx = canvasRef!.getContext('2d');
            if (!ctx) return;
            // Resize canvas to match frame dimensions
            if (canvasRef!.width !== img.width || canvasRef!.height !== img.height) {
                canvasRef!.width = img.width;
                canvasRef!.height = img.height;
            }
            ctx.drawImage(img, 0, 0);
        };
        img.src = `data:image/jpeg;base64,${base64}`;
    }

    function disconnect() {
        frameUnlisten?.();
        statusUnlisten?.();
        frameUnlisten = undefined;
        statusUnlisten = undefined;
        if (fpsInterval) { clearInterval(fpsInterval); fpsInterval = undefined; }
        import('@tauri-apps/api/core').then(({ invoke }) => {
            invoke('stop_remote_session', { deviceId: props.deviceId }).catch(() => {});
        }).catch(() => {});
        setState('disconnected');
    }

    function handleDisconnect() {
        disconnect();
        props.onDisconnect();
    }

    // ---- Mouse / Keyboard Input ----
    function canvasCoords(e: MouseEvent): { x: number; y: number } {
        if (!canvasRef) return { x: 0, y: 0 };
        const rect = canvasRef.getBoundingClientRect();
        const scaleX = canvasRef.width / rect.width;
        const scaleY = canvasRef.height / rect.height;
        return {
            x: Math.round((e.clientX - rect.left) * scaleX),
            y: Math.round((e.clientY - rect.top) * scaleY),
        };
    }

    function mouseButton(e: MouseEvent): number {
        // 0=left, 1=middle, 2=right
        if (e.button === 0) return 1;
        if (e.button === 1) return 4;
        if (e.button === 2) return 2;
        return 1;
    }

    function sendInput(payload: Record<string, unknown>) {
        if (state() !== 'connected') return;
        import('@tauri-apps/api/core').then(({ invoke }) => {
            invoke('send_remote_input', { payload }).catch(() => {});
        }).catch(() => {});
    }

    function handleMouseMove(e: MouseEvent) {
        const { x, y } = canvasCoords(e);
        sendInput({ type: 'mouse_move', x, y });
    }

    function handleMouseDown(e: MouseEvent) {
        e.preventDefault();
        canvasRef?.focus();
        const { x, y } = canvasCoords(e);
        sendInput({ type: 'mouse_down', x, y, button: mouseButton(e) });
    }

    function handleMouseUp(e: MouseEvent) {
        const { x, y } = canvasCoords(e);
        sendInput({ type: 'mouse_up', x, y, button: mouseButton(e) });
    }

    function handleWheel(e: WheelEvent) {
        e.preventDefault();
        const { x, y } = canvasCoords(e);
        sendInput({
            type: 'wheel',
            x, y,
            delta_x: Math.sign(e.deltaX) * -1,
            delta_y: Math.sign(e.deltaY) * -1,
        });
    }

    function modifierFlags(e: KeyboardEvent): string[] {
        const mods: string[] = [];
        if (e.ctrlKey) mods.push('ctrl');
        if (e.shiftKey) mods.push('shift');
        if (e.altKey) mods.push('alt');
        if (e.metaKey) mods.push('meta');
        return mods;
    }

    function handleKeyDown(e: KeyboardEvent) {
        e.preventDefault();
        sendInput({ type: 'key_down', key: e.key, modifiers: modifierFlags(e) });
    }

    function handleKeyUp(e: KeyboardEvent) {
        e.preventDefault();
        sendInput({ type: 'key_up', key: e.key, modifiers: modifierFlags(e) });
    }

    function handleContextMenu(e: MouseEvent) {
        e.preventDefault();
    }

    // ---- Toolbar Actions ----
    function toggleFullscreen() {
        if (!containerRef) return;
        if (!document.fullscreenElement) {
            containerRef.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
        } else {
            document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
        }
    }

    function requestRefresh() {
        sendInput({ type: 'refresh_video' });
    }

    function sendCtrlAltDel() {
        import('@tauri-apps/api/core').then(({ invoke }) => {
            invoke('send_special_key', { key: 'ctrl_alt_del' }).catch(() => {});
        }).catch(() => {});
    }

    function stateIcon(): string {
        switch (state()) {
            case 'connecting': return 'sync';
            case 'connected': return 'desktop_windows';
            case 'disconnected': return 'desktop_access_disabled';
            case 'error': return 'error';
        }
    }

    function stateColor(): string {
        switch (state()) {
            case 'connecting': return 'var(--accent-orange)';
            case 'connected': return 'var(--accent-green)';
            case 'disconnected': return 'var(--text-tertiary)';
            case 'error': return 'var(--accent-red)';
        }
    }

    return (
        <div class="remote-view page-enter" ref={containerRef}>
            {/* Toolbar */}
            <div class="remote-toolbar">
                <div class="remote-toolbar-left">
                    <span class="material-symbols-rounded" style={`color: ${stateColor()}; font-size: 18px;`}>
                        {stateIcon()}
                    </span>
                    <span class="remote-device-name">
                        {device()?.hostname || props.deviceId}
                    </span>
                    <Show when={state() === 'connected'}>
                        <span class="remote-stats">
                            {fps()} FPS · {latency()}ms
                        </span>
                    </Show>
                </div>
                <div class="remote-toolbar-right">
                    <Show when={state() === 'connected'}>
                        <button class="btn-icon" title={t('remote.refresh')} onClick={requestRefresh}>
                            <span class="material-symbols-rounded">refresh</span>
                        </button>
                        <button class="btn-icon" title={t('remote.ctrl_alt_del')} onClick={sendCtrlAltDel}>
                            <span class="material-symbols-rounded">keyboard</span>
                        </button>
                        <button class="btn-icon" title={t('remote.fullscreen')} onClick={toggleFullscreen}>
                            <span class="material-symbols-rounded">
                                {isFullscreen() ? 'fullscreen_exit' : 'fullscreen'}
                            </span>
                        </button>
                    </Show>
                    <button class="btn-secondary" onClick={handleDisconnect} style="padding: 4px 12px;">
                        <span class="material-symbols-rounded" style="font-size: 16px; margin-right: 4px;">power_settings_new</span>
                        {t('remote.disconnect')}
                    </button>
                </div>
            </div>

            {/* Canvas / Status */}
            <div class="remote-canvas-container">
                <Show when={state() === 'connected'} fallback={
                    <div class="remote-status-overlay">
                        <span class="material-symbols-rounded" style={`font-size: 64px; color: ${stateColor()};`}>
                            {stateIcon()}
                        </span>
                        <div class="remote-status-text">
                            {state() === 'connecting' && t('remote.connecting')}
                            {state() === 'disconnected' && t('remote.disconnected')}
                            {state() === 'error' && (errorMsg() || t('remote.connect_failed'))}
                        </div>
                        <Show when={state() === 'error'}>
                            <button class="btn-primary" style="width: auto; padding: 8px 20px; margin-top: 12px;" onClick={startConnection}>
                                {t('common.retry')}
                            </button>
                        </Show>
                    </div>
                }>
                    <canvas
                        ref={canvasRef}
                        class="remote-canvas"
                        tabIndex={0}
                        onMouseMove={handleMouseMove}
                        onMouseDown={handleMouseDown}
                        onMouseUp={handleMouseUp}
                        onWheel={handleWheel}
                        onKeyDown={handleKeyDown}
                        onKeyUp={handleKeyUp}
                        onContextMenu={handleContextMenu}
                    />
                </Show>
            </div>
        </div>
    );
}
