/**
 * Dashboard — overview with stat cards, quick connect, recent sessions
 */
import { createSignal, onMount, Show } from 'solid-js';
import { t } from '../lib/i18n';
import { getDevices, getServerHealth, type Device, type ServerHealth } from '../lib/api';

interface DashboardProps {
    onNavigate: (panel: string) => void;
}

export default function Dashboard(props: DashboardProps) {
    const [health, setHealth] = createSignal<ServerHealth | null>(null);
    const [devices, setDevices] = createSignal<Device[]>([]);
    const [loading, setLoading] = createSignal(true);
    const [connectId, setConnectId] = createSignal('');

    onMount(async () => {
        await loadData();
    });

    async function loadData() {
        setLoading(true);
        try {
            const [h, d] = await Promise.all([
                getServerHealth().catch(() => null),
                getDevices().catch(() => []),
            ]);
            setHealth(h);
            setDevices(d);
        } finally {
            setLoading(false);
        }
    }

    function onlineCount() {
        return devices().filter(d => d.online || d.status === 'online').length;
    }

    function handleQuickConnect() {
        const id = connectId().trim();
        if (id) {
            // Navigate to remote view with device ID
            props.onNavigate(`remote:${id}`);
        }
    }

    return (
        <div class="page-enter">
            {/* Stat Cards */}
            <div class="dashboard-grid">
                <div class="stat-card">
                    <div class="stat-icon blue">
                        <span class="material-symbols-rounded">dns</span>
                    </div>
                    <div class="stat-info">
                        <div class="stat-value">
                            <Show when={health()} fallback="—">
                                <span class={`status-indicator ${health()!.status === 'ok' ? 'connected' : 'disconnected'}`}>
                                    <span class="status-dot online" />
                                    {t('dashboard.connected')}
                                </span>
                            </Show>
                        </div>
                        <div class="stat-label">{t('dashboard.server_status')}</div>
                    </div>
                </div>

                <div class="stat-card">
                    <div class="stat-icon green">
                        <span class="material-symbols-rounded">wifi</span>
                    </div>
                    <div class="stat-info">
                        <div class="stat-value">{onlineCount()}</div>
                        <div class="stat-label">{t('dashboard.online_devices')}</div>
                    </div>
                </div>

                <div class="stat-card">
                    <div class="stat-icon orange">
                        <span class="material-symbols-rounded">devices</span>
                    </div>
                    <div class="stat-info">
                        <div class="stat-value">{devices().length}</div>
                        <div class="stat-label">{t('dashboard.total_devices')}</div>
                    </div>
                </div>
            </div>

            {/* Quick Connect */}
            <div class="section-title">{t('dashboard.quick_connect')}</div>
            <div class="quick-connect">
                <input
                    type="text"
                    class="form-input"
                    placeholder={t('dashboard.quick_connect_placeholder')}
                    value={connectId()}
                    onInput={(e) => setConnectId(e.currentTarget.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleQuickConnect()}
                />
                <button class="btn-primary" onClick={handleQuickConnect} style="width: auto; padding: 8px 20px;">
                    {t('dashboard.connect')}
                </button>
            </div>

            {/* Recent Online Devices */}
            <div class="section-title">{t('dashboard.online_devices')}</div>
            <Show when={!loading()} fallback={<div class="loading-center"><div class="spinner" /></div>}>
                <Show when={devices().filter(d => d.online || d.status === 'online').length > 0} fallback={
                    <div class="empty-state">
                        <span class="material-symbols-rounded">devices_off</span>
                        <div class="empty-state-text">{t('devices.no_devices')}</div>
                    </div>
                }>
                    <div class="device-table-container">
                        <table class="device-table">
                            <thead>
                                <tr>
                                    <th>{t('devices.col_id')}</th>
                                    <th>{t('devices.col_hostname')}</th>
                                    <th>{t('devices.col_platform')}</th>
                                    <th>{t('devices.col_status')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {devices()
                                    .filter(d => d.online || d.status === 'online')
                                    .slice(0, 10)
                                    .map(device => (
                                        <tr onClick={() => props.onNavigate(`remote:${device.id}`)}>
                                            <td>{device.id}</td>
                                            <td>{device.hostname || '—'}</td>
                                            <td>{device.platform || '—'}</td>
                                            <td>
                                                <span class="status-dot online" />
                                                {t('devices.status_online')}
                                            </td>
                                        </tr>
                                    ))}
                            </tbody>
                        </table>
                    </div>
                </Show>
            </Show>
        </div>
    );
}
