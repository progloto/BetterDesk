/**
 * Sidebar — main navigation
 */
import { t } from '../lib/i18n';
import { user, doLogout } from '../stores/auth';
import bdIcon from '../assets/bd-icon.png';

interface SidebarProps {
    active: string;
    onNavigate: (panel: string) => void;
}

interface NavEntry {
    id: string;
    icon: string;
    labelKey: string;
}

const mainNav: NavEntry[] = [
    { id: 'dashboard', icon: 'dashboard', labelKey: 'sidebar.dashboard' },
    { id: 'devices',   icon: 'devices',   labelKey: 'sidebar.devices' },
    { id: 'remote',    icon: 'desktop_windows', labelKey: 'sidebar.remote' },
    { id: 'chat',      icon: 'chat',      labelKey: 'sidebar.chat' },
];

const footerNav: NavEntry[] = [
    { id: 'settings',  icon: 'settings',  labelKey: 'sidebar.settings' },
];

export default function Sidebar(props: SidebarProps) {
    function handleLogout() {
        doLogout();
    }

    function renderItem(entry: NavEntry) {
        const isActive = () => props.active === entry.id;
        return (
            <button
                class={`nav-item ${isActive() ? 'active' : ''}`}
                onClick={() => props.onNavigate(entry.id)}
                title={t(entry.labelKey)}
            >
                <span class="material-symbols-rounded">{entry.icon}</span>
                <span class="nav-label">{t(entry.labelKey)}</span>
            </button>
        );
    }

    return (
        <aside class="sidebar">
            <div class="sidebar-header">
                <img src={bdIcon} alt="" class="sidebar-logo" />
                <span class="sidebar-brand">{t('app.name')}</span>
            </div>

            <nav class="sidebar-nav">
                {mainNav.map(renderItem)}
            </nav>

            <div class="sidebar-footer">
                {footerNav.map(renderItem)}
                <button class="nav-item" onClick={handleLogout} title={t('sidebar.logout')}>
                    <span class="material-symbols-rounded">logout</span>
                    <span class="nav-label">{t('sidebar.logout')}</span>
                </button>
            </div>
        </aside>
    );
}
