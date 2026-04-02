/**
 * DeviceList — full device table with search, filters, click-to-connect
 */
import { createSignal, createMemo, onMount, Show, For } from 'solid-js';
import { t } from '../lib/i18n';
import { getDevices, type Device } from '../lib/api';

interface DeviceListProps {
    onNavigate: (panel: string) => void;
}

type Filter = 'all' | 'online' | 'offline';

export default function DeviceList(props: DeviceListProps) {
    const [devices, setDevices] = createSignal<Device[]>([]);
    const [loading, setLoading] = createSignal(true);
    const [search, setSearch] = createSignal('');
    const [filter, setFilter] = createSignal<Filter>('all');

    onMount(async () => {
        setLoading(true);
        try {
            const list = await getDevices();
            setDevices(list);
        } catch {
            // silently handle
        } finally {
            setLoading(false);
        }
    });

    const filtered = createMemo(() => {
        let list = devices();
        const q = search().toLowerCase().trim();

        if (q) {
            list = list.filter(d =>
                d.id.toLowerCase().includes(q) ||
                (d.hostname || '').toLowerCase().includes(q) ||
                (d.platform || '').toLowerCase().includes(q) ||
                (d.tags || '').toLowerCase().includes(q)
            );
        }

        if (filter() === 'online') {
            list = list.filter(d => d.online || d.status === 'online');
        } else if (filter() === 'offline') {
            list = list.filter(d => !d.online && d.status !== 'online');
        }

        return list;
    });

    function formatLastSeen(iso: string): string {
        if (!iso) return '—';
        try {
            const d = new Date(iso);
            const now = Date.now();
            const diff = now - d.getTime();
            if (diff < 60_000) return 'just now';
            if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
            if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
            return d.toLocaleDateString();
        } catch {
            return iso;
        }
    }

    function isOnline(device: Device): boolean {
        return device.online || device.status === 'online';
    }

    return (
        <div class="page-enter">
            <div class="device-table-container">
                {/* Toolbar */}
                <div class="device-toolbar">
                    <input
                        type="text"
                        class="form-input device-search"
                        placeholder={t('devices.search_placeholder')}
                        value={search()}
                        onInput={(e) => setSearch(e.currentTarget.value)}
                    />
                    <div class="filter-pills">
                        <button
                            class={`filter-pill ${filter() === 'all' ? 'active' : ''}`}
                            onClick={() => setFilter('all')}
                        >
                            {t('devices.filter_all')} ({devices().length})
                        </button>
                        <button
                            class={`filter-pill ${filter() === 'online' ? 'active' : ''}`}
                            onClick={() => setFilter('online')}
                        >
                            {t('devices.filter_online')} ({devices().filter(d => isOnline(d)).length})
                        </button>
                        <button
                            class={`filter-pill ${filter() === 'offline' ? 'active' : ''}`}
                            onClick={() => setFilter('offline')}
                        >
                            {t('devices.filter_offline')} ({devices().filter(d => !isOnline(d)).length})
                        </button>
                    </div>
                </div>

                {/* Table */}
                <Show when={!loading()} fallback={<div class="loading-center"><div class="spinner" /></div>}>
                    <Show when={filtered().length > 0} fallback={
                        <div class="empty-state">
                            <span class="material-symbols-rounded">search_off</span>
                            <div class="empty-state-text">{t('devices.no_devices')}</div>
                        </div>
                    }>
                        <table class="device-table">
                            <thead>
                                <tr>
                                    <th>{t('devices.col_id')}</th>
                                    <th>{t('devices.col_hostname')}</th>
                                    <th>{t('devices.col_platform')}</th>
                                    <th>{t('devices.col_status')}</th>
                                    <th>{t('devices.col_last_seen')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                <For each={filtered()}>
                                    {(device) => (
                                        <tr onClick={() => props.onNavigate(`remote:${device.id}`)}>
                                            <td style="font-family: var(--font-mono); font-size: var(--font-size-sm);">
                                                {device.id}
                                            </td>
                                            <td>{device.hostname || '—'}</td>
                                            <td>{device.platform || '—'}</td>
                                            <td>
                                                <span class={`status-dot ${isOnline(device) ? 'online' : 'offline'}`} />
                                                {isOnline(device) ? t('devices.status_online') : t('devices.status_offline')}
                                            </td>
                                            <td style="color: var(--text-secondary);">
                                                {formatLastSeen(device.last_online)}
                                            </td>
                                        </tr>
                                    )}
                                </For>
                            </tbody>
                        </table>
                    </Show>
                </Show>
            </div>
        </div>
    );
}
