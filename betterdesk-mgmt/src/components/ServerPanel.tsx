/**
 * ServerPanel — server management with tabs: Health, Clients, Operators, API Keys, Audit
 *
 * Uses Tauri IPC commands (server_get_*) which proxy to Go server via JWT.
 */
import { createSignal, createResource, Show, For, Switch, Match } from 'solid-js';
import { t } from '../lib/i18n';
import { toastSuccess, toastError } from '../stores/toast';

type Tab = 'health' | 'clients' | 'operators' | 'keys' | 'audit';

interface HealthData {
    uptime?: number;
    version?: string;
    peers_online?: number;
    peers_total?: number;
    relay_sessions?: number;
    goroutines?: number;
    memory_mb?: number;
}

interface Client {
    id: string;
    ip?: string;
    protocol?: string;
    connected_at?: string;
    last_seen?: string;
}

interface Operator {
    id?: number;
    username: string;
    role: string;
    last_login?: string;
}

interface ApiKey {
    id?: number;
    name: string;
    key_prefix?: string;
    created_at?: string;
    last_used?: string;
}

interface AuditEntry {
    id?: number;
    action: string;
    actor?: string;
    details?: string;
    ip?: string;
    created_at?: string;
}

async function invokeCmd<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(cmd, args);
}

export default function ServerPanel() {
    const [tab, setTab] = createSignal<Tab>('health');

    // Resources (lazy-loaded per tab)
    const [health, { refetch: refetchHealth }] = createResource(
        () => tab() === 'health',
        async (active) => active ? invokeCmd<HealthData>('server_get_health') : null
    );
    const [clients, { refetch: refetchClients }] = createResource(
        () => tab() === 'clients',
        async (active) => active ? invokeCmd<Client[]>('server_get_clients') : []
    );
    const [operators] = createResource(
        () => tab() === 'operators',
        async (active) => active ? invokeCmd<Operator[]>('server_get_operators') : []
    );
    const [keys, { refetch: refetchKeys }] = createResource(
        () => tab() === 'keys',
        async (active) => active ? invokeCmd<ApiKey[]>('server_get_api_keys') : []
    );
    const [audit] = createResource(
        () => tab() === 'audit',
        async (active) => active ? invokeCmd<AuditEntry[]>('server_get_audit') : []
    );

    async function disconnectClient(id: string) {
        try {
            await invokeCmd('server_disconnect_client', { clientId: id });
            toastSuccess(t('server.client_disconnected'));
            refetchClients();
        } catch {
            toastError(t('server.action_failed'));
        }
    }

    async function banClient(id: string) {
        if (!confirm(t('server.confirm_ban'))) return;
        try {
            await invokeCmd('server_ban_client', { clientId: id });
            toastSuccess(t('server.client_banned'));
            refetchClients();
        } catch {
            toastError(t('server.action_failed'));
        }
    }

    async function revokeKey(keyId: string) {
        if (!confirm(t('server.confirm_revoke_key'))) return;
        try {
            await invokeCmd('server_revoke_api_key', { keyId });
            toastSuccess(t('server.key_revoked'));
            refetchKeys();
        } catch {
            toastError(t('server.action_failed'));
        }
    }

    function formatUptime(secs?: number): string {
        if (!secs) return '—';
        const d = Math.floor(secs / 86400);
        const h = Math.floor((secs % 86400) / 3600);
        const m = Math.floor((secs % 3600) / 60);
        if (d > 0) return `${d}d ${h}h`;
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    }

    function formatTime(iso?: string): string {
        if (!iso) return '—';
        try { return new Date(iso).toLocaleString(); } catch { return iso; }
    }

    const tabs: { id: Tab; icon: string; labelKey: string }[] = [
        { id: 'health', icon: 'monitor_heart', labelKey: 'server.tab_health' },
        { id: 'clients', icon: 'people', labelKey: 'server.tab_clients' },
        { id: 'operators', icon: 'admin_panel_settings', labelKey: 'server.tab_operators' },
        { id: 'keys', icon: 'key', labelKey: 'server.tab_keys' },
        { id: 'audit', icon: 'history', labelKey: 'server.tab_audit' },
    ];

    return (
        <div class="page-enter">
            {/* Tabs */}
            <div class="detail-tabs" style="margin-bottom: 20px;">
                <For each={tabs}>
                    {(entry) => (
                        <button
                            class={`detail-tab ${tab() === entry.id ? 'active' : ''}`}
                            onClick={() => setTab(entry.id)}
                        >
                            <span class="material-symbols-rounded" style="font-size: 16px; margin-right: 4px; vertical-align: -3px;">{entry.icon}</span>
                            {t(entry.labelKey)}
                        </button>
                    )}
                </For>
            </div>

            <Switch>
                {/* Health */}
                <Match when={tab() === 'health'}>
                    <div class="panel-card">
                        <div class="panel-card-header">
                            <span>{t('server.tab_health')}</span>
                            <button class="btn-icon" onClick={() => refetchHealth()} title={t('common.retry')}>
                                <span class="material-symbols-rounded">refresh</span>
                            </button>
                        </div>
                        <Show when={health()} fallback={<div class="loading-center"><div class="spinner" /></div>}>
                            {(h) => (
                                <div class="stat-grid-4">
                                    <div class="stat-card">
                                        <div class="stat-icon green"><span class="material-symbols-rounded">timer</span></div>
                                        <div class="stat-info"><span class="stat-value">{formatUptime(h()?.uptime)}</span><span class="stat-label">{t('server.uptime')}</span></div>
                                    </div>
                                    <div class="stat-card">
                                        <div class="stat-icon blue"><span class="material-symbols-rounded">devices</span></div>
                                        <div class="stat-info"><span class="stat-value">{h()?.peers_online ?? 0}</span><span class="stat-label">{t('server.peers_online')}</span></div>
                                    </div>
                                    <div class="stat-card">
                                        <div class="stat-icon orange"><span class="material-symbols-rounded">swap_horiz</span></div>
                                        <div class="stat-info"><span class="stat-value">{h()?.relay_sessions ?? 0}</span><span class="stat-label">{t('server.relay_sessions')}</span></div>
                                    </div>
                                    <div class="stat-card">
                                        <div class="stat-icon blue"><span class="material-symbols-rounded">memory</span></div>
                                        <div class="stat-info"><span class="stat-value">{h()?.memory_mb ?? 0} MB</span><span class="stat-label">{t('server.memory')}</span></div>
                                    </div>
                                </div>
                            )}
                        </Show>
                    </div>
                </Match>

                {/* Clients */}
                <Match when={tab() === 'clients'}>
                    <div class="panel-card">
                        <div class="panel-card-header">
                            <span>{t('server.tab_clients')}</span>
                            <button class="btn-icon" onClick={() => refetchClients()} title={t('common.retry')}>
                                <span class="material-symbols-rounded">refresh</span>
                            </button>
                        </div>
                        <Show when={!clients.loading} fallback={<div class="loading-center"><div class="spinner" /></div>}>
                            <Show when={(clients() || []).length > 0} fallback={
                                <div class="empty-state"><span class="material-symbols-rounded">group_off</span><div class="empty-state-text">{t('server.no_clients')}</div></div>
                            }>
                                <table class="device-table">
                                    <thead><tr>
                                        <th>ID</th><th>IP</th><th>{t('server.protocol')}</th><th>{t('server.connected_at')}</th><th style="width: 80px;"></th>
                                    </tr></thead>
                                    <tbody>
                                        <For each={clients() || []}>
                                            {(c) => (
                                                <tr>
                                                    <td style="font-family: var(--font-mono);">{c.id}</td>
                                                    <td>{c.ip || '—'}</td>
                                                    <td>{c.protocol || '—'}</td>
                                                    <td>{formatTime(c.connected_at)}</td>
                                                    <td>
                                                        <div style="display: flex; gap: 4px;">
                                                            <button class="btn-icon" title={t('server.disconnect')} onClick={() => disconnectClient(c.id)}>
                                                                <span class="material-symbols-rounded" style="font-size: 16px;">link_off</span>
                                                            </button>
                                                            <button class="btn-icon" title={t('server.ban')} onClick={() => banClient(c.id)} style="color: var(--accent-red);">
                                                                <span class="material-symbols-rounded" style="font-size: 16px;">block</span>
                                                            </button>
                                                        </div>
                                                    </td>
                                                </tr>
                                            )}
                                        </For>
                                    </tbody>
                                </table>
                            </Show>
                        </Show>
                    </div>
                </Match>

                {/* Operators */}
                <Match when={tab() === 'operators'}>
                    <div class="panel-card">
                        <div class="panel-card-header"><span>{t('server.tab_operators')}</span></div>
                        <Show when={!operators.loading} fallback={<div class="loading-center"><div class="spinner" /></div>}>
                            <Show when={(operators() || []).length > 0} fallback={
                                <div class="empty-state"><span class="material-symbols-rounded">admin_panel_settings</span><div class="empty-state-text">{t('server.no_operators')}</div></div>
                            }>
                                <table class="device-table">
                                    <thead><tr>
                                        <th>{t('server.username')}</th><th>{t('server.role')}</th><th>{t('server.last_login')}</th>
                                    </tr></thead>
                                    <tbody>
                                        <For each={operators() || []}>
                                            {(op) => (
                                                <tr>
                                                    <td>{op.username}</td>
                                                    <td><span class={`role-badge ${op.role}`}>{op.role}</span></td>
                                                    <td>{formatTime(op.last_login)}</td>
                                                </tr>
                                            )}
                                        </For>
                                    </tbody>
                                </table>
                            </Show>
                        </Show>
                    </div>
                </Match>

                {/* API Keys */}
                <Match when={tab() === 'keys'}>
                    <div class="panel-card">
                        <div class="panel-card-header">
                            <span>{t('server.tab_keys')}</span>
                            <button class="btn-icon" onClick={() => refetchKeys()} title={t('common.retry')}>
                                <span class="material-symbols-rounded">refresh</span>
                            </button>
                        </div>
                        <Show when={!keys.loading} fallback={<div class="loading-center"><div class="spinner" /></div>}>
                            <Show when={(keys() || []).length > 0} fallback={
                                <div class="empty-state"><span class="material-symbols-rounded">key_off</span><div class="empty-state-text">{t('server.no_keys')}</div></div>
                            }>
                                <table class="device-table">
                                    <thead><tr>
                                        <th>{t('server.key_name')}</th><th>{t('server.key_prefix')}</th><th>{t('server.created')}</th><th>{t('server.last_used')}</th><th style="width: 48px;"></th>
                                    </tr></thead>
                                    <tbody>
                                        <For each={keys() || []}>
                                            {(k) => (
                                                <tr>
                                                    <td>{k.name}</td>
                                                    <td style="font-family: var(--font-mono);">{k.key_prefix || '****'}...</td>
                                                    <td>{formatTime(k.created_at)}</td>
                                                    <td>{formatTime(k.last_used)}</td>
                                                    <td>
                                                        <button class="btn-icon" title={t('server.revoke')} onClick={() => revokeKey(String(k.id || k.name))} style="color: var(--accent-red);">
                                                            <span class="material-symbols-rounded" style="font-size: 16px;">delete</span>
                                                        </button>
                                                    </td>
                                                </tr>
                                            )}
                                        </For>
                                    </tbody>
                                </table>
                            </Show>
                        </Show>
                    </div>
                </Match>

                {/* Audit */}
                <Match when={tab() === 'audit'}>
                    <div class="panel-card">
                        <div class="panel-card-header"><span>{t('server.tab_audit')}</span></div>
                        <Show when={!audit.loading} fallback={<div class="loading-center"><div class="spinner" /></div>}>
                            <Show when={(audit() || []).length > 0} fallback={
                                <div class="empty-state"><span class="material-symbols-rounded">history</span><div class="empty-state-text">{t('server.no_audit')}</div></div>
                            }>
                                <table class="device-table">
                                    <thead><tr>
                                        <th>{t('server.action')}</th><th>{t('server.actor')}</th><th>{t('server.details')}</th><th>IP</th><th>{t('server.time')}</th>
                                    </tr></thead>
                                    <tbody>
                                        <For each={audit() || []}>
                                            {(entry) => (
                                                <tr>
                                                    <td><span class={`action-badge action-${actionColor(entry.action)}`}>{entry.action}</span></td>
                                                    <td>{entry.actor || '—'}</td>
                                                    <td class="audit-details">{entry.details || '—'}</td>
                                                    <td style="font-family: var(--font-mono);">{entry.ip || '—'}</td>
                                                    <td>{formatTime(entry.created_at)}</td>
                                                </tr>
                                            )}
                                        </For>
                                    </tbody>
                                </table>
                            </Show>
                        </Show>
                    </div>
                </Match>
            </Switch>
        </div>
    );
}

function actionColor(action: string): string {
    if (!action) return 'gray';
    const a = action.toLowerCase();
    if (a.includes('login') || a.includes('auth')) return 'green';
    if (a.includes('ban') || a.includes('block') || a.includes('revoke')) return 'red';
    if (a.includes('fail') || a.includes('error')) return 'orange';
    return 'blue';
}
