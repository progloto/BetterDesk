/**
 * SessionHistoryPanel — displays past remote desktop session logs
 *
 * Fetches from `operator_get_session_history` Tauri IPC → Go server audit log.
 */
import { createSignal, createResource, Show, For } from 'solid-js';
import { t } from '../lib/i18n';

interface Session {
    id?: number;
    device_id?: string;
    peer_id?: string;
    operator?: string;
    action?: string;
    details?: string;
    ip?: string;
    created_at?: string;
    duration?: number;
}

export default function SessionHistoryPanel() {
    const [page, setPage] = createSignal(0);
    const PAGE_SIZE = 50;

    const [sessions, { refetch }] = createResource(async () => {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const result = await invoke<Session[]>('operator_get_session_history', {
                limit: PAGE_SIZE, offset: page() * PAGE_SIZE,
            });
            return Array.isArray(result) ? result : [];
        } catch {
            return [];
        }
    });

    function formatTime(iso?: string): string {
        if (!iso) return '—';
        try { return new Date(iso).toLocaleString(); } catch { return iso; }
    }

    function formatDuration(secs?: number): string {
        if (!secs || secs <= 0) return '—';
        if (secs < 60) return `${secs}s`;
        if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        return `${h}h ${m}m`;
    }

    return (
        <div class="page-enter">
            <div class="panel-card">
                <div class="panel-card-header">
                    <span>{t('sessions.title')}</span>
                    <button class="btn-icon" onClick={() => refetch()} title={t('common.retry')}>
                        <span class="material-symbols-rounded">refresh</span>
                    </button>
                </div>
                <Show when={!sessions.loading} fallback={<div class="loading-center"><div class="spinner" /></div>}>
                    <Show when={(sessions() || []).length > 0} fallback={
                        <div class="empty-state">
                            <span class="material-symbols-rounded">history</span>
                            <div class="empty-state-text">{t('sessions.no_sessions')}</div>
                        </div>
                    }>
                        <table class="device-table">
                            <thead>
                                <tr>
                                    <th>{t('sessions.device')}</th>
                                    <th>{t('sessions.operator')}</th>
                                    <th>{t('sessions.action')}</th>
                                    <th>{t('sessions.started')}</th>
                                    <th>{t('sessions.duration')}</th>
                                    <th>IP</th>
                                </tr>
                            </thead>
                            <tbody>
                                <For each={sessions() || []}>
                                    {(s) => (
                                        <tr>
                                            <td style="font-family: var(--font-mono);">{s.device_id || s.peer_id || '—'}</td>
                                            <td>{s.operator || '—'}</td>
                                            <td><span class={`action-badge action-${s.action?.includes('start') ? 'green' : 'blue'}`}>{s.action || '—'}</span></td>
                                            <td>{formatTime(s.created_at)}</td>
                                            <td>{formatDuration(s.duration)}</td>
                                            <td style="font-family: var(--font-mono);">{s.ip || '—'}</td>
                                        </tr>
                                    )}
                                </For>
                            </tbody>
                        </table>
                        <div class="table-pagination">
                            <button class="btn-secondary" disabled={page() === 0} onClick={() => { setPage(p => p - 1); refetch(); }}>
                                <span class="material-symbols-rounded" style="font-size: 16px;">chevron_left</span>
                            </button>
                            <span class="pagination-info">{t('sessions.page')} {page() + 1}</span>
                            <button class="btn-secondary" disabled={(sessions() || []).length < PAGE_SIZE} onClick={() => { setPage(p => p + 1); refetch(); }}>
                                <span class="material-symbols-rounded" style="font-size: 16px;">chevron_right</span>
                            </button>
                        </div>
                    </Show>
                </Show>
            </div>
        </div>
    );
}
