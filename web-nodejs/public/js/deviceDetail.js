/**
 * BetterDesk Console - Device Detail Panel
 * Enterprise-grade slide-over panel for device management.
 *
 * Usage:
 *   DeviceDetail.open(deviceId)   — opens the panel
 *   DeviceDetail.close()          — closes the panel
 *
 * Dispatches 'deviceDetail:changed' on document when device is modified.
 */

const DeviceDetail = (function () {
    'use strict';

    // ──────────────────────────────────────────────────────────────────────
    // State
    // ──────────────────────────────────────────────────────────────────────
    let overlayEl = null;
    let device = null;
    let activeTab = 'overview';
    let refreshTimer = null;

    // ──────────────────────────────────────────────────────────────────────
    // Public API
    // ──────────────────────────────────────────────────────────────────────

    /**
     * Open device detail panel for the given device ID.
     * @param {string} deviceId
     */
    async function open(deviceId) {
        if (!deviceId) return;
        activeTab = 'overview';
        _createOverlay();
        _showLoading();
        _show();

        try {
            device = await Utils.api('/api/devices/' + encodeURIComponent(deviceId));
            _render();
        } catch (err) {
            console.error('DeviceDetail: failed to load device', err);
            Notifications.error(err.message || _('errors.load_device_failed'));
            close();
        }

        // Auto-refresh every 15 s while panel is open
        _startRefresh(deviceId);
    }

    /**
     * Close the panel.
     */
    function close() {
        _stopRefresh();
        if (overlayEl) {
            overlayEl.classList.remove('open');
            setTimeout(() => {
                if (overlayEl) {
                    overlayEl.remove();
                    overlayEl = null;
                }
            }, 300);
        }
        device = null;
    }

    // ──────────────────────────────────────────────────────────────────────
    // Overlay / skeleton
    // ──────────────────────────────────────────────────────────────────────

    function _createOverlay() {
        if (overlayEl) overlayEl.remove();

        overlayEl = document.createElement('div');
        overlayEl.className = 'device-panel-overlay';
        overlayEl.innerHTML = '<div class="device-panel" id="device-panel-inner"></div>';

        // Close on overlay click
        overlayEl.addEventListener('click', function (e) {
            if (e.target === overlayEl) close();
        });

        // Escape key
        overlayEl._escHandler = function (e) {
            if (e.key === 'Escape') close();
        };
        document.addEventListener('keydown', overlayEl._escHandler);

        document.body.appendChild(overlayEl);
    }

    function _show() {
        requestAnimationFrame(() => {
            if (overlayEl) overlayEl.classList.add('open');
        });
    }

    function _showLoading() {
        const inner = overlayEl.querySelector('#device-panel-inner');
        inner.innerHTML = `
            <div class="device-panel-loading">
                <div class="device-panel-spinner"></div>
                <div class="device-panel-loading-text">${_('common.loading')}</div>
            </div>`;
    }

    // ──────────────────────────────────────────────────────────────────────
    // Render
    // ──────────────────────────────────────────────────────────────────────

    function _render() {
        if (!overlayEl || !device) return;
        const inner = overlayEl.querySelector('#device-panel-inner');

        inner.innerHTML = _headerHTML() + _tabsHTML() + _contentHTML() + _footerHTML();

        _attachEvents();
        _switchTab(activeTab);
    }

    // ── Header ──

    function _headerHTML() {
        const d = device;
        const platformLabel = d.platform || '-';
        const platformIcon = Utils.getPlatformIcon(d.platform);
        const statusClass = d.banned ? 'banned' : (d.status_tier || (d.online ? 'online' : 'offline'));
        const statusLabel = d.banned
            ? _('status.banned')
            : (_('status.' + (d.status_tier || (d.online ? 'online' : 'offline'))));

        return `
        <div class="device-panel-header">
            <div class="device-panel-header-top">
                <div class="device-panel-identity">
                    <div class="device-panel-id-row">
                        <span class="device-panel-device-id">${Utils.escapeHtml(d.id)}</span>
                        <button class="device-panel-copy-btn" data-copy="${Utils.escapeHtml(d.id)}" title="${_('actions.copy')}">
                            <span class="material-icons">content_copy</span>
                        </button>
                    </div>
                    <div class="device-panel-subtitle">
                        <span class="material-icons">${platformIcon}</span>
                        <span>${Utils.escapeHtml(d.hostname || d.note || '-')}</span>
                        ${d.username ? ` &middot; <span>${Utils.escapeHtml(d.username)}</span>` : ''}
                    </div>
                </div>
                <button class="device-panel-close" title="${_('actions.close')}">
                    <span class="material-icons">close</span>
                </button>
            </div>
            <div class="device-panel-status-bar">
                <span class="device-panel-status-badge ${statusClass}">
                    <span class="status-dot"></span>${statusLabel}
                </span>
                <span class="device-panel-platform-badge">
                    <span class="material-icons">${platformIcon}</span>
                    ${Utils.escapeHtml(platformLabel)}
                </span>
            </div>
        </div>`;
    }

    // ── Tabs ──

    function _tabsHTML() {
        const tabs = [
            { id: 'overview',  icon: 'info',            label: _('device_detail.tab_overview') },
            { id: 'hardware',  icon: 'memory',          label: _('device_detail.tab_hardware') },
            { id: 'metrics',   icon: 'monitoring',      label: _('device_detail.tab_metrics') },
            { id: 'tags',      icon: 'sell',             label: _('device_detail.tab_tags') },
            { id: 'actions',   icon: 'play_arrow',       label: _('device_detail.tab_actions') }
        ];
        return `<div class="device-panel-tabs">` +
            tabs.map(t =>
                `<button class="device-panel-tab${t.id === activeTab ? ' active' : ''}" data-tab="${t.id}">
                    <span class="material-icons">${t.icon}</span>${t.label}
                </button>`
            ).join('') +
            `</div>`;
    }

    // ── Content ──

    function _contentHTML() {
        return `<div class="device-panel-content">
            ${_overviewPane()}
            ${_hardwarePane()}
            ${_metricsPane()}
            ${_tagsPane()}
            ${_actionsPane()}
        </div>`;
    }

    // ── Overview tab ──

    function _overviewPane() {
        const d = device;
        let html = `<div class="device-panel-tab-pane" data-pane="overview">`;

        // Ban alert
        if (d.banned) {
            html += `
            <div class="device-panel-ban-alert">
                <span class="material-icons">gpp_bad</span>
                <div class="device-panel-ban-alert-text">
                    <div class="device-panel-ban-alert-title">${_('device_detail.device_banned')}</div>
                    <div class="device-panel-ban-alert-reason">${d.ban_reason ? Utils.escapeHtml(d.ban_reason) : _('device_detail.no_reason')}</div>
                </div>
            </div>`;
        }

        // Quick metrics summary (if available)
        if (d.metrics) {
            html += `
            <div class="device-panel-section">
                <div class="device-panel-section-title"><span class="material-icons">monitoring</span> ${_('device_detail.section_live_metrics')}</div>
                <div class="device-panel-metrics-grid">
                    ${_metricCard('CPU', d.metrics.cpu_usage, 'speed')}
                    ${_metricCard(_('device_detail.metric_memory'), d.metrics.memory_usage, 'memory')}
                    ${_metricCard(_('device_detail.metric_disk'), d.metrics.disk_usage, 'storage')}
                </div>
                ${d.metrics.updated_at ? `<div class="device-panel-metrics-updated">${_('device_detail.metrics_updated')} ${Utils.formatRelativeTime(d.metrics.updated_at)}</div>` : ''}
            </div>`;
        }

        // Identity section
        html += `
        <div class="device-panel-section">
            <div class="device-panel-section-title"><span class="material-icons">badge</span> ${_('device_detail.section_identity')}</div>
            <div class="device-panel-info-grid">
                ${_infoRow(_('devices.id'), `<span class="mono">${Utils.escapeHtml(d.id)}</span>`, d.id)}
                ${_infoRow(_('devices.hostname'), Utils.escapeHtml(d.hostname || d.note || '-'))}
                ${_infoRow(_('devices.username'), Utils.escapeHtml(d.username || '-'))}
                ${d.uuid ? _infoRow('UUID', `<span class="mono">${Utils.escapeHtml(d.uuid)}</span>`) : ''}
                ${_infoRow(_('devices.platform'), Utils.escapeHtml(d.platform || (d.sysinfo && d.sysinfo.platform) || '-'))}
                ${d.sysinfo && d.sysinfo.version ? _infoRow(_('device_detail.version'), Utils.escapeHtml(d.sysinfo.version)) : ''}
            </div>
        </div>`;

        // Network section
        html += `
        <div class="device-panel-section">
            <div class="device-panel-section-title"><span class="material-icons">lan</span> ${_('device_detail.section_network')}</div>
            <div class="device-panel-info-grid">
                ${_infoRow(_('devices.ip_address'), d.ip ? `<span class="mono">${Utils.escapeHtml(d.ip)}</span>` : '-', d.ip)}
                ${_infoRow(_('device_detail.folder'), _folderName(d.folder_id))}
                ${d.groups && d.groups.length > 0 ? _infoRow(_('device_detail.device_groups'), d.groups.map(g => `<span class="device-panel-group-badge">${Utils.escapeHtml(g.name || g.guid)}</span>`).join(' ')) : ''}
            </div>
        </div>`;

        // Timestamps
        html += `
        <div class="device-panel-section">
            <div class="device-panel-section-title"><span class="material-icons">schedule</span> ${_('device_detail.section_timestamps')}</div>
            <div class="device-panel-info-grid">
                ${_infoRow(_('devices.first_seen'), Utils.formatDate(d.created_at))}
                ${_infoRow(_('devices.last_seen'), _lastSeenValue(d.last_online))}
                ${d.status_tier && d.status_tier !== 'online' && d.status_tier !== 'offline'
                    ? _infoRow(_('device_detail.status_tier'), _statusTierBadge(d.status_tier))
                    : ''}
            </div>
        </div>`;

        html += `</div>`;
        return html;
    }

    // ── Hardware tab (sysinfo data) ──

    function _hardwarePane() {
        const d = device;
        const s = d.sysinfo || {};
        let html = `<div class="device-panel-tab-pane" data-pane="hardware">`;

        if (!d.sysinfo) {
            html += `
            <div class="device-panel-empty-state">
                <span class="material-icons">memory</span>
                <p>${_('device_detail.no_sysinfo')}</p>
                <p class="device-panel-empty-hint">${_('device_detail.no_sysinfo_hint')}</p>
            </div>`;
            html += `</div>`;
            return html;
        }

        // System section
        html += `
        <div class="device-panel-section">
            <div class="device-panel-section-title"><span class="material-icons">computer</span> ${_('device_detail.section_system')}</div>
            <div class="device-panel-info-grid">
                ${s.hostname ? _infoRow(_('devices.hostname'), Utils.escapeHtml(s.hostname)) : ''}
                ${s.username ? _infoRow(_('devices.username'), Utils.escapeHtml(s.username)) : ''}
                ${s.os_full ? _infoRow(_('device_detail.os'), Utils.escapeHtml(s.os_full)) : ''}
                ${s.platform ? _infoRow(_('devices.platform'), Utils.escapeHtml(s.platform)) : ''}
                ${s.version ? _infoRow(_('device_detail.version'), Utils.escapeHtml(s.version)) : ''}
            </div>
        </div>`;

        // CPU section
        html += `
        <div class="device-panel-section">
            <div class="device-panel-section-title"><span class="material-icons">speed</span> ${_('device_detail.section_cpu')}</div>
            <div class="device-panel-info-grid">
                ${s.cpu_name ? _infoRow(_('device_detail.cpu_model'), Utils.escapeHtml(s.cpu_name)) : ''}
                ${s.cpu_cores ? _infoRow(_('device_detail.cpu_cores'), s.cpu_cores + ' cores') : ''}
                ${s.cpu_freq_ghz ? _infoRow(_('device_detail.cpu_freq'), _formatFreq(s.cpu_freq_ghz)) : ''}
            </div>
        </div>`;

        // Memory section
        if (s.memory_gb) {
            html += `
            <div class="device-panel-section">
                <div class="device-panel-section-title"><span class="material-icons">memory</span> ${_('device_detail.section_memory')}</div>
                <div class="device-panel-info-grid">
                    ${_infoRow(_('device_detail.total_memory'), _formatMemory(s.memory_gb))}
                </div>
            </div>`;
        }

        // Displays section
        const displays = _safeParseJSON(s.displays_json || s.displays, []);
        if (displays.length > 0) {
            html += `
            <div class="device-panel-section">
                <div class="device-panel-section-title"><span class="material-icons">monitor</span> ${_('device_detail.section_displays')}</div>
                <div class="device-panel-displays-list">
                    ${displays.map((disp, i) => {
                        const w = disp.width || disp.w || 0;
                        const h = disp.height || disp.h || 0;
                        const name = disp.name || ('#' + (i + 1));
                        return `<div class="device-panel-display-item">
                            <span class="material-icons">monitor</span>
                            <span>${Utils.escapeHtml(name)}</span>
                            ${w && h ? `<span class="device-panel-display-res">${w}×${h}</span>` : ''}
                        </div>`;
                    }).join('')}
                </div>
            </div>`;
        }

        // Encoding capabilities
        const encoding = _safeParseJSON(s.encoding_json || s.encoding, []);
        if (encoding.length > 0) {
            html += `
            <div class="device-panel-section">
                <div class="device-panel-section-title"><span class="material-icons">videocam</span> ${_('device_detail.section_encoding')}</div>
                <div class="device-panel-encoding-tags">
                    ${encoding.map(e => {
                        const label = typeof e === 'string' ? e : (e.name || e.codec || JSON.stringify(e));
                        return `<span class="device-panel-encoding-tag">${Utils.escapeHtml(label)}</span>`;
                    }).join('')}
                </div>
            </div>`;
        }

        html += `</div>`;
        return html;
    }

    // ── Metrics tab (CPU, memory, disk usage) ──

    function _metricsPane() {
        const d = device;
        let html = `<div class="device-panel-tab-pane" data-pane="metrics">`;

        if (!d.metrics && (!d.metrics_history || d.metrics_history.length === 0)) {
            html += `
            <div class="device-panel-empty-state">
                <span class="material-icons">monitoring</span>
                <p>${_('device_detail.no_metrics')}</p>
                <p class="device-panel-empty-hint">${_('device_detail.no_metrics_hint')}</p>
            </div>`;
            html += `</div>`;
            return html;
        }

        // Current metrics
        if (d.metrics) {
            html += `
            <div class="device-panel-section">
                <div class="device-panel-section-title"><span class="material-icons">speed</span> ${_('device_detail.section_current_usage')}</div>
                <div class="device-panel-metrics-grid">
                    ${_metricCard('CPU', d.metrics.cpu_usage, 'speed')}
                    ${_metricCard(_('device_detail.metric_memory'), d.metrics.memory_usage, 'memory')}
                    ${_metricCard(_('device_detail.metric_disk'), d.metrics.disk_usage, 'storage')}
                </div>
                ${d.metrics.updated_at ? `<div class="device-panel-metrics-updated">${_('device_detail.metrics_updated')} ${Utils.formatRelativeTime(d.metrics.updated_at)}</div>` : ''}
            </div>`;
        }

        // Metrics history (simple bar chart)
        if (d.metrics_history && d.metrics_history.length > 1) {
            html += `
            <div class="device-panel-section">
                <div class="device-panel-section-title"><span class="material-icons">timeline</span> ${_('device_detail.section_usage_history')}</div>
                <div class="device-panel-chart-container">
                    <div class="device-panel-chart-label">CPU</div>
                    <div class="device-panel-mini-chart" id="dp-chart-cpu">
                        ${_miniBarChart(d.metrics_history.map(m => m.cpu), 'cpu')}
                    </div>
                    <div class="device-panel-chart-label">${_('device_detail.metric_memory')}</div>
                    <div class="device-panel-mini-chart" id="dp-chart-memory">
                        ${_miniBarChart(d.metrics_history.map(m => m.memory), 'memory')}
                    </div>
                    <div class="device-panel-chart-label">${_('device_detail.metric_disk')}</div>
                    <div class="device-panel-mini-chart" id="dp-chart-disk">
                        ${_miniBarChart(d.metrics_history.map(m => m.disk), 'disk')}
                    </div>
                </div>
                <div class="device-panel-chart-legend">
                    <span>${_('device_detail.chart_oldest')}</span>
                    <span>${_('device_detail.chart_newest')}</span>
                </div>
            </div>`;
        }

        html += `</div>`;
        return html;
    }

    // ── Tags & Notes tab ──

    function _tagsPane() {
        const d = device;
        const tags = d.tags || [];
        const hasTags = tags.length > 0;

        let html = `<div class="device-panel-tab-pane" data-pane="tags">`;

        // Tags section
        html += `
        <div class="device-panel-section">
            <div class="device-panel-section-title"><span class="material-icons">sell</span> ${_('device_detail.tags')}</div>
            <div class="device-panel-tags-container" id="dp-tags-list">
                ${hasTags
                    ? tags.map(t => `
                        <span class="device-panel-tag">
                            ${Utils.escapeHtml(t)}
                            <button class="device-panel-tag-remove" data-tag="${Utils.escapeHtml(t)}" title="${_('actions.delete')}">
                                <span class="material-icons">close</span>
                            </button>
                        </span>`).join('')
                    : `<div class="device-panel-tags-empty">${_('device_detail.no_tags')}</div>`
                }
            </div>
            <div class="device-panel-tag-input-row">
                <input type="text" class="device-panel-tag-input" id="dp-tag-input"
                       placeholder="${_('device_detail.tag_placeholder')}" maxlength="50">
                <button class="device-panel-tag-add-btn" id="dp-tag-add-btn">
                    <span class="material-icons">add</span>${_('device_detail.add_tag')}
                </button>
            </div>
        </div>`;

        // Notes section
        html += `
        <div class="device-panel-section">
            <div class="device-panel-section-title"><span class="material-icons">notes</span> ${_('device_detail.notes')}</div>
            <textarea class="device-panel-notes-textarea" id="dp-notes-textarea"
                      placeholder="${_('device_detail.notes_placeholder')}">${Utils.escapeHtml(d.note || '')}</textarea>
            <div class="device-panel-notes-actions">
                <button class="btn btn-primary btn-sm" id="dp-notes-save">
                    <span class="material-icons">save</span>${_('actions.save')}
                </button>
            </div>
        </div>`;

        html += `</div>`;
        return html;
    }

    // ── Actions tab ──

    function _actionsPane() {
        const d = device;
        const isBanned = d.banned;

        let html = `<div class="device-panel-tab-pane" data-pane="actions">`;

        // Connection actions
        html += `
        <div class="device-panel-section">
            <div class="device-panel-section-title"><span class="material-icons">link</span> ${_('device_detail.section_connect')}</div>
            <div class="device-panel-actions-grid">
                <div class="device-panel-action-card" data-action="connect-web">
                    <div class="device-panel-action-icon green">
                        <span class="material-icons">language</span>
                    </div>
                    <div class="device-panel-action-text">
                        <div class="device-panel-action-title">${_('device_detail.action_connect_web')}</div>
                        <div class="device-panel-action-desc">${_('device_detail.action_connect_web_desc')}</div>
                    </div>
                </div>
                <div class="device-panel-action-card" data-action="connect-native-remote">
                    <div class="device-panel-action-icon teal" style="background:rgba(20,184,166,.15);color:#14b8a6">
                        <span class="material-icons">connected_tv</span>
                    </div>
                    <div class="device-panel-action-text">
                        <div class="device-panel-action-title">${_('device_detail.action_native_remote') || 'BetterDesk Remote'}</div>
                        <div class="device-panel-action-desc">${_('device_detail.action_native_remote_desc') || 'Native JPEG stream viewer'}</div>
                    </div>
                </div>
                <div class="device-panel-action-card" data-action="connect-desktop">
                    <div class="device-panel-action-icon purple">
                        <span class="material-icons">computer</span>
                    </div>
                    <div class="device-panel-action-text">
                        <div class="device-panel-action-title">${_('device_detail.action_connect_desktop')}</div>
                        <div class="device-panel-action-desc">${_('device_detail.action_connect_desktop_desc')}</div>
                    </div>
                </div>
            </div>
        </div>`;

        // Management actions
        html += `
        <div class="device-panel-section">
            <div class="device-panel-section-title"><span class="material-icons">settings</span> ${_('device_detail.section_manage')}</div>
            <div class="device-panel-actions-grid">
                <div class="device-panel-action-card" data-action="change-id">
                    <div class="device-panel-action-icon blue">
                        <span class="material-icons">swap_horiz</span>
                    </div>
                    <div class="device-panel-action-text">
                        <div class="device-panel-action-title">${_('devices.change_id')}</div>
                        <div class="device-panel-action-desc">${_('device_detail.action_change_id_desc')}</div>
                    </div>
                </div>
                <div class="device-panel-action-card" data-action="toggle-ban">
                    <div class="device-panel-action-icon ${isBanned ? 'green' : 'orange'}">
                        <span class="material-icons">${isBanned ? 'check_circle' : 'block'}</span>
                    </div>
                    <div class="device-panel-action-text">
                        <div class="device-panel-action-title">${isBanned ? _('actions.unban') : _('actions.ban')}</div>
                        <div class="device-panel-action-desc">${isBanned ? _('device_detail.action_unban_desc') : _('device_detail.action_ban_desc')}</div>
                    </div>
                </div>
            </div>
        </div>`;

        // Danger zone
        html += `
        <div class="device-panel-danger-zone">
            <div class="device-panel-section-title"><span class="material-icons">warning</span> ${_('device_detail.danger_zone')}</div>
            <div class="device-panel-actions-grid">
                <div class="device-panel-action-card" data-action="delete">
                    <div class="device-panel-action-icon red">
                        <span class="material-icons">delete_forever</span>
                    </div>
                    <div class="device-panel-action-text">
                        <div class="device-panel-action-title">${_('actions.delete')}</div>
                        <div class="device-panel-action-desc">${_('device_detail.action_delete_desc')}</div>
                    </div>
                </div>
            </div>
        </div>`;

        html += `</div>`;
        return html;
    }

    // ── Footer ──

    function _footerHTML() {
        return `
        <div class="device-panel-footer">
            <button class="btn btn-primary" id="dp-connect-btn">
                <span class="material-icons">link</span>${_('actions.connect')}
            </button>
            <button class="btn btn-secondary" id="dp-close-btn">
                ${_('actions.close')}
            </button>
        </div>`;
    }

    // ──────────────────────────────────────────────────────────────────────
    // Helpers
    // ──────────────────────────────────────────────────────────────────────

    function _infoRow(label, valueHTML, copyValue) {
        const copyBtn = copyValue
            ? `<button class="device-panel-copy-btn" data-copy="${Utils.escapeHtml(copyValue)}" title="${_('actions.copy')}">
                <span class="material-icons">content_copy</span>
               </button>`
            : '';
        return `
        <div class="device-panel-info-row">
            <span class="device-panel-info-label">${label}</span>
            <span class="device-panel-info-value">${valueHTML}${copyBtn}</span>
        </div>`;
    }

    /**
     * Render a metric card with circular progress indicator
     */
    function _metricCard(label, value, icon) {
        const pct = Math.min(100, Math.max(0, Math.round(value || 0)));
        const colorClass = pct > 90 ? 'critical' : pct > 70 ? 'warning' : 'normal';
        return `
        <div class="device-panel-metric-card ${colorClass}">
            <div class="device-panel-metric-header">
                <span class="material-icons">${icon}</span>
                <span class="device-panel-metric-label">${label}</span>
            </div>
            <div class="device-panel-metric-bar-container">
                <div class="device-panel-metric-bar" style="width: ${pct}%"></div>
            </div>
            <div class="device-panel-metric-value">${pct}%</div>
        </div>`;
    }

    /**
     * Render a mini bar chart from an array of values (0-100)
     */
    function _miniBarChart(values, type) {
        if (!values || values.length === 0) return '';
        // Reverse so oldest is on the left
        const reversed = [...values].reverse();
        return `<div class="device-panel-mini-bars">` +
            reversed.map(v => {
                const pct = Math.min(100, Math.max(0, Math.round(v || 0)));
                const colorClass = pct > 90 ? 'critical' : pct > 70 ? 'warning' : 'normal';
                return `<div class="device-panel-mini-bar ${colorClass}" style="height: ${Math.max(2, pct)}%" title="${pct}%"></div>`;
            }).join('') +
            `</div>`;
    }

    /**
     * Format CPU frequency
     */
    function _formatFreq(ghz) {
        if (!ghz || ghz <= 0) return '-';
        if (ghz >= 1) return ghz.toFixed(2) + ' GHz';
        return (ghz * 1000).toFixed(0) + ' MHz';
    }

    /**
     * Format memory size
     */
    function _formatMemory(gb) {
        if (!gb || gb <= 0) return '-';
        if (gb >= 1024) return (gb / 1024).toFixed(1) + ' TB';
        if (gb >= 1) return gb.toFixed(1) + ' GB';
        return (gb * 1024).toFixed(0) + ' MB';
    }

    /**
     * Safely parse JSON string or return fallback
     */
    function _safeParseJSON(val, fallback) {
        if (Array.isArray(val)) return val;
        if (typeof val === 'object' && val !== null) return val;
        if (typeof val !== 'string' || !val) return fallback;
        try { return JSON.parse(val); } catch (e) { return fallback; }
    }

    function _lastSeenValue(lastOnline) {
        if (!lastOnline) return '-';
        const abs = Utils.formatDate(lastOnline);
        const rel = Utils.formatRelativeTime(lastOnline);
        return `${abs} <span style="color:var(--text-tertiary);font-size:var(--font-size-xs)">(${rel})</span>`;
    }

    function _folderName(folderId) {
        if (!folderId) return _('folders.unassigned');
        // Try to get folder name from the global folders list (devices.js maintains it)
        if (window._betterdesk_folders) {
            const f = window._betterdesk_folders.find(f => f.id === folderId);
            if (f) return Utils.escapeHtml(f.name);
        }
        return '#' + folderId;
    }

    function _statusTierBadge(tier) {
        const cls = tier || 'offline';
        const label = _('status.' + cls) || cls;
        return `<span class="device-panel-status-badge ${cls}"><span class="status-dot"></span>${label}</span>`;
    }

    // ──────────────────────────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────────────────────────

    function _attachEvents() {
        if (!overlayEl) return;
        const panel = overlayEl.querySelector('#device-panel-inner');

        // Close button
        panel.querySelector('.device-panel-close')?.addEventListener('click', close);

        // Footer buttons
        panel.querySelector('#dp-close-btn')?.addEventListener('click', close);
        panel.querySelector('#dp-connect-btn')?.addEventListener('click', function () {
            if (device) window.location.href = '/remote/' + encodeURIComponent(device.id);
        });

        // Tabs
        panel.querySelectorAll('.device-panel-tab').forEach(function (tab) {
            tab.addEventListener('click', function () {
                _switchTab(tab.dataset.tab);
            });
        });

        // Copy buttons
        panel.querySelectorAll('.device-panel-copy-btn').forEach(function (btn) {
            btn.addEventListener('click', async function (e) {
                e.stopPropagation();
                const text = btn.dataset.copy;
                if (!text) return;
                await Utils.copyToClipboard(text);
                Notifications.success(_('common.copied'));
            });
        });

        // Tag events
        _attachTagEvents(panel);

        // Notes save
        panel.querySelector('#dp-notes-save')?.addEventListener('click', _saveNotes);

        // Action cards
        panel.querySelectorAll('.device-panel-action-card').forEach(function (card) {
            card.addEventListener('click', function () {
                if (card.classList.contains('disabled')) return;
                _handleAction(card.dataset.action);
            });
        });
    }

    function _switchTab(tabId) {
        activeTab = tabId;
        if (!overlayEl) return;
        const panel = overlayEl.querySelector('#device-panel-inner');

        panel.querySelectorAll('.device-panel-tab').forEach(function (t) {
            t.classList.toggle('active', t.dataset.tab === tabId);
        });
        panel.querySelectorAll('.device-panel-tab-pane').forEach(function (p) {
            p.classList.toggle('active', p.dataset.pane === tabId);
        });
    }

    // ── Tags ──

    function _attachTagEvents(panel) {
        const addBtn = panel.querySelector('#dp-tag-add-btn');
        const input = panel.querySelector('#dp-tag-input');

        if (addBtn && input) {
            addBtn.addEventListener('click', function () { _addTag(input.value.trim()); });
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); _addTag(input.value.trim()); }
            });
        }

        panel.querySelectorAll('.device-panel-tag-remove').forEach(function (btn) {
            btn.addEventListener('click', function () { _removeTag(btn.dataset.tag); });
        });
    }

    async function _addTag(tag) {
        if (!tag || !device) return;
        const tags = [...(device.tags || [])];
        if (tags.includes(tag)) {
            Notifications.warning(_('device_detail.tag_exists'));
            return;
        }
        tags.push(tag);
        await _saveTags(tags);
    }

    async function _removeTag(tag) {
        if (!device) return;
        const tags = (device.tags || []).filter(function (t) { return t !== tag; });
        await _saveTags(tags);
    }

    async function _saveTags(tags) {
        try {
            await Utils.api('/api/devices/' + encodeURIComponent(device.id) + '/tags', {
                method: 'PUT',
                body: { tags: tags }
            });
            device.tags = tags;
            _render();
            _switchTab('tags');
            _notifyChanged();
            Notifications.success(_('common.saved'));
        } catch (err) {
            Notifications.error(err.message || _('errors.server_error'));
        }
    }

    // ── Notes ──

    async function _saveNotes() {
        if (!device) return;
        const textarea = overlayEl.querySelector('#dp-notes-textarea');
        if (!textarea) return;
        const note = textarea.value.trim();

        try {
            await Utils.api('/api/devices/' + encodeURIComponent(device.id), {
                method: 'PATCH',
                body: { note: note }
            });
            device.note = note;
            _notifyChanged();
            Notifications.success(_('common.saved'));
        } catch (err) {
            Notifications.error(err.message || _('errors.server_error'));
        }
    }

    // ── Actions ──

    async function _handleAction(action) {
        if (!device) return;

        switch (action) {
            case 'connect-web':
                window.location.href = '/remote/' + encodeURIComponent(device.id);
                break;

            case 'connect-native-remote':
                window.location.href = '/remote-desktop/' + encodeURIComponent(device.id);
                break;

            case 'connect-desktop':
                window.open('rustdesk://' + encodeURIComponent(device.id), '_blank');
                break;

            case 'change-id':
                await _changeId();
                break;

            case 'toggle-ban':
                await _toggleBan();
                break;

            case 'delete':
                await _deleteDevice();
                break;
        }
    }

    async function _changeId() {
        const newId = await Modal.prompt({
            title: _('devices.change_id_title'),
            label: _('devices.new_id'),
            placeholder: 'NEWID123',
            hint: _('devices.change_id_hint')
        });
        if (!newId) return;
        if (newId.length < 6 || newId.length > 16) {
            Notifications.error(_('devices.id_length_error'));
            return;
        }
        if (!/^[A-Z0-9_-]+$/i.test(newId)) {
            Notifications.error(_('devices.id_format_error'));
            return;
        }
        try {
            await Utils.api('/api/devices/' + encodeURIComponent(device.id) + '/change-id', {
                method: 'POST',
                body: { newId: newId.toUpperCase() }
            });
            Notifications.success(_('devices.change_id_success'));
            close();
            _notifyChanged();
        } catch (err) {
            Notifications.error(err.message || _('errors.change_id_failed'));
        }
    }

    async function _toggleBan() {
        const isBanned = device.banned;
        const action = isBanned ? 'unban' : 'ban';
        const confirmed = await Modal.confirm({
            title: _('devices.' + action + '_title'),
            message: _('devices.' + action + '_confirm', { id: device.id }),
            confirmLabel: _(isBanned ? 'actions.unban' : 'actions.ban'),
            danger: !isBanned
        });
        if (!confirmed) return;
        try {
            await Utils.api('/api/devices/' + encodeURIComponent(device.id) + '/' + action, { method: 'POST' });
            Notifications.success(_('devices.' + action + '_success'));
            // Refresh panel
            const id = device.id;
            device = await Utils.api('/api/devices/' + encodeURIComponent(id));
            _render();
            _switchTab('actions');
            _notifyChanged();
        } catch (err) {
            Notifications.error(err.message || _('errors.' + action + '_failed'));
        }
    }

    async function _deleteDevice() {
        const confirmed = await Modal.confirm({
            title: _('devices.delete_title'),
            message: _('devices.delete_confirm', { id: device.id }),
            confirmLabel: _('actions.delete'),
            confirmIcon: 'delete',
            danger: true
        });
        if (!confirmed) return;
        try {
            await Utils.api('/api/devices/' + encodeURIComponent(device.id), { method: 'DELETE' });
            Notifications.success(_('devices.delete_success'));
            close();
            _notifyChanged();
        } catch (err) {
            Notifications.error(err.message || _('errors.delete_failed'));
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    // Auto-refresh
    // ──────────────────────────────────────────────────────────────────────

    function _startRefresh(deviceId) {
        _stopRefresh();
        refreshTimer = setInterval(async function () {
            try {
                const updated = await Utils.api('/api/devices/' + encodeURIComponent(deviceId));
                if (updated && overlayEl) {
                    device = updated;
                    // Only re-render header status (minimal update, avoid losing form state)
                    const statusBar = overlayEl.querySelector('.device-panel-status-bar');
                    if (statusBar) {
                        const statusClass = device.banned ? 'banned' : (device.status_tier || (device.online ? 'online' : 'offline'));
                        const statusLabel = device.banned
                            ? _('status.banned')
                            : (_('status.' + (device.status_tier || (device.online ? 'online' : 'offline'))));
                        const badge = statusBar.querySelector('.device-panel-status-badge');
                        if (badge) {
                            badge.className = 'device-panel-status-badge ' + statusClass;
                            badge.innerHTML = '<span class="status-dot"></span>' + statusLabel;
                        }
                    }
                }
            } catch (e) {
                // Silent — device may have been deleted
            }
        }, 15000);
    }

    function _stopRefresh() {
        if (refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = null;
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    // Notify parent (devices table) of changes
    // ──────────────────────────────────────────────────────────────────────

    function _notifyChanged() {
        document.dispatchEvent(new CustomEvent('deviceDetail:changed'));
    }

    // ──────────────────────────────────────────────────────────────────────
    // Cleanup on navigation
    // ──────────────────────────────────────────────────────────────────────
    window.addEventListener('beforeunload', function () {
        _stopRefresh();
    });

    return { open: open, close: close };
})();

window.DeviceDetail = DeviceDetail;
