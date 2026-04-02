/**
 * Layout — app shell with sidebar, topbar, and content area
 */
import { createSignal, Show, Switch, Match } from 'solid-js';
import { t } from '../lib/i18n';
import { user } from '../stores/auth';
import Sidebar from './Sidebar';
import Dashboard from './Dashboard';
import DeviceList from './DeviceList';
import Settings from './Settings';

export default function Layout() {
    const [activePanel, setActivePanel] = createSignal('dashboard');

    function handleNavigate(panel: string) {
        setActivePanel(panel);
    }

    function panelTitle(): string {
        const p = activePanel();
        if (p === 'dashboard') return t('dashboard.title');
        if (p === 'devices') return t('devices.title');
        if (p.startsWith('remote')) return t('remote.title');
        if (p === 'chat') return t('chat.title');
        if (p === 'settings') return t('settings.title');
        return '';
    }

    function sidebarActive(): string {
        const p = activePanel();
        if (p.startsWith('remote')) return 'remote';
        return p;
    }

    function userInitials(): string {
        const u = user();
        if (!u) return '?';
        return u.username.charAt(0).toUpperCase();
    }

    return (
        <div class="app-layout">
            <Sidebar active={sidebarActive()} onNavigate={handleNavigate} />

            <div class="main-content">
                <div class="topbar">
                    <div class="topbar-title">{panelTitle()}</div>
                    <div class="topbar-actions">
                        <Show when={user()}>
                            <div class="topbar-user">
                                <div class="topbar-avatar">{userInitials()}</div>
                                <span>{user()!.username}</span>
                            </div>
                        </Show>
                    </div>
                </div>

                <div class="page-content">
                    <Switch fallback={<Dashboard onNavigate={handleNavigate} />}>
                        <Match when={activePanel() === 'dashboard'}>
                            <Dashboard onNavigate={handleNavigate} />
                        </Match>
                        <Match when={activePanel() === 'devices'}>
                            <DeviceList onNavigate={handleNavigate} />
                        </Match>
                        <Match when={activePanel().startsWith('remote')}>
                            <div class="empty-state">
                                <span class="material-symbols-rounded">desktop_windows</span>
                                <div class="empty-state-text">{t('remote.not_connected')}</div>
                                <div style="color: var(--text-tertiary); font-size: var(--font-size-sm); margin-top: 4px;">
                                    {t('remote.connect_hint')}
                                </div>
                            </div>
                        </Match>
                        <Match when={activePanel() === 'chat'}>
                            <div class="empty-state">
                                <span class="material-symbols-rounded">chat</span>
                                <div class="empty-state-text">{t('chat.no_conversations')}</div>
                            </div>
                        </Match>
                        <Match when={activePanel() === 'settings'}>
                            <Settings />
                        </Match>
                    </Switch>
                </div>
            </div>
        </div>
    );
}
