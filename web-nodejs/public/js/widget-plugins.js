/**
 * BetterDesk Console — Widget Plugin System
 * Registry + 12 built-in widget types for the desktop dashboard.
 * Depends: desktop-widgets.js, Utils, _ (i18n)
 */

(function () {
    'use strict';

    var _registry = new Map();
    var t = function (k) { return typeof _ === 'function' ? _(k) : k; };

    function esc(s) {
        var d = document.createElement('div');
        d.textContent = s || '';
        return d.innerHTML;
    }

    // ============ Registry API ============

    function register(type, config) {
        if (!type || !config) return;
        config.type = type;
        _registry.set(type, config);
    }

    function get(type) { return _registry.get(type); }

    function list() {
        var arr = [];
        _registry.forEach(function (v) { arr.push(v); });
        return arr;
    }

    // ============ Helpers ============

    function apiGet(url) {
        if (typeof Utils !== 'undefined' && Utils.api) {
            return Utils.api(url).then(function (res) {
                if (res && typeof res.json === 'function') return res.json();
                return res;
            });
        }
        return fetch(url, { credentials: 'same-origin' }).then(function (r) { return r.json(); });
    }

    function buildGaugeSVG(pct, size) {
        size = size || 100;
        var r = (size - 8) / 2;
        var circ = 2 * Math.PI * r;
        var off = circ * (1 - pct / 100);
        var cls = pct > 85 ? 'danger' : (pct > 65 ? 'warning' : '');
        return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' +
            '<circle class="gauge-bg" cx="' + (size / 2) + '" cy="' + (size / 2) + '" r="' + r + '"/>' +
            '<circle class="gauge-fill ' + cls + '" cx="' + (size / 2) + '" cy="' + (size / 2) + '" r="' + r + '" ' +
                'stroke-dasharray="' + circ + '" stroke-dashoffset="' + off + '"/>' +
        '</svg>';
    }

    function timeSince(date) {
        var seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
        if (seconds < 60) return seconds + 's';
        if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
        if (seconds < 86400) return Math.floor(seconds / 3600) + 'h';
        return Math.floor(seconds / 86400) + 'd';
    }

    // ============ Built-in Widgets ============

    // 1. Clock
    register('clock', {
        name: t('desktop.widget_clock'),
        icon: 'schedule',
        color: '#58a6ff',
        category: 'general',
        description: 'Digital clock with date',
        defaultSize: { w: 240, h: 160 },
        minSize: { w: 180, h: 120 },
        _interval: null,
        render: function (body) {
            body.innerHTML = '<div class="widget-clock-time"></div><div class="widget-clock-date"></div>';
            this._tick(body);
            var self = this;
            body._clockInterval = setInterval(function () { self._tick(body); }, 1000);
        },
        _tick: function (body) {
            var now = new Date();
            var timeEl = body.querySelector('.widget-clock-time');
            var dateEl = body.querySelector('.widget-clock-date');
            if (timeEl) {
                var h = String(now.getHours()).padStart(2, '0');
                var m = String(now.getMinutes()).padStart(2, '0');
                var s = String(now.getSeconds()).padStart(2, '0');
                timeEl.innerHTML = h + ':' + m + '<span class="widget-clock-seconds">:' + s + '</span>';
            }
            if (dateEl) {
                dateEl.textContent = now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
            }
        },
        destroy: function (body) {
            if (body && body._clockInterval) {
                clearInterval(body._clockInterval);
                body._clockInterval = null;
            }
        }
    });

    // 2. Device Status (counters)
    register('device-status', {
        name: t('desktop.widget_device_status'),
        icon: 'devices',
        color: '#3fb950',
        category: 'monitoring',
        description: 'Online / offline / total device counters',
        defaultSize: { w: 320, h: 160 },
        minSize: { w: 240, h: 130 },
        updateInterval: 15000,
        render: function (body) {
            body.innerHTML = '<div class="widget-status-counters">' +
                '<div class="widget-status-counter online"><div class="widget-status-counter-value">-</div><div class="widget-status-counter-label">' + t('desktop.label_online') + '</div></div>' +
                '<div class="widget-status-counter offline"><div class="widget-status-counter-value">-</div><div class="widget-status-counter-label">' + t('desktop.label_offline') + '</div></div>' +
                '<div class="widget-status-counter total"><div class="widget-status-counter-value">-</div><div class="widget-status-counter-label">' + t('desktop.label_total') + '</div></div>' +
            '</div>';
        },
        update: function (body) {
            apiGet('/api/stats').then(function (data) {
                if (!data || !data.devices) return;
                var d = data.devices;
                var online = body.querySelector('.online .widget-status-counter-value');
                var offline = body.querySelector('.offline .widget-status-counter-value');
                var total = body.querySelector('.total .widget-status-counter-value');
                if (online) online.textContent = d.online || 0;
                if (offline) offline.textContent = d.offline || 0;
                if (total) total.textContent = d.total || 0;
            }).catch(function () {});
        }
    });

    // 3. Server Info (combined health + ports + uptime)
    register('server-health', {
        name: t('desktop.widget_server_health'),
        icon: 'dns',
        color: '#f0883e',
        category: 'monitoring',
        description: 'Services, ports, and uptime overview',
        defaultSize: { w: 380, h: 280 },
        minSize: { w: 300, h: 220 },
        updateInterval: 20000,
        render: function (body) {
            body.innerHTML = '<div class="widget-server-info">' +
                '<div class="widget-si-services">' +
                    '<div class="widget-si-svc" data-svc="signal"><div class="widget-si-dot unknown"></div><span>Signal</span></div>' +
                    '<div class="widget-si-svc" data-svc="relay"><div class="widget-si-dot unknown"></div><span>Relay</span></div>' +
                    '<div class="widget-si-svc" data-svc="console"><div class="widget-si-dot up"></div><span>Console</span></div>' +
                '</div>' +
                '<div class="widget-si-uptime" data-si="uptime">' + t('desktop.label_uptime') + ': -</div>' +
                '<div class="widget-si-ports">' +
                    '<div class="widget-si-port-header"><span>' + t('desktop.label_service') + '</span><span>' + t('desktop.label_port') + '</span></div>' +
                '</div></div>';
        },
        update: function (body) {
            apiGet('/api/server/status').then(function (data) {
                if (!data) return;
                // Services
                var sig = (data.signal || data.hbbs || {}).status || 'unknown';
                var rel = (data.hbbr || {}).status || 'unknown';
                var sigEl = body.querySelector('[data-svc="signal"]');
                var relEl = body.querySelector('[data-svc="relay"]');
                if (sigEl) { var d = sigEl.querySelector('.widget-si-dot'); if (d) d.className = 'widget-si-dot ' + (sig === 'running' ? 'up' : 'down'); }
                if (relEl) { var d = relEl.querySelector('.widget-si-dot'); if (d) d.className = 'widget-si-dot ' + (rel === 'running' ? 'up' : 'down'); }
                // Uptime
                var ut = body.querySelector('[data-si="uptime"]');
                if (ut && data.uptime != null) {
                    var s = data.uptime;
                    var days = Math.floor(s / 86400); s %= 86400;
                    var hrs = Math.floor(s / 3600); s %= 3600;
                    var mins = Math.floor(s / 60);
                    var parts = [];
                    if (days) parts.push(days + 'd');
                    if (hrs) parts.push(hrs + 'h');
                    parts.push(mins + 'm');
                    ut.textContent = t('desktop.label_uptime') + ': ' + parts.join(' ');
                }
                // Ports
                var pc = body.querySelector('.widget-si-ports');
                if (!pc) return;
                var rows = [
                    { name: 'Signal', port: data.signal_port || 21116, up: sig === 'running' },
                    { name: 'Relay', port: data.relay_port || 21117, up: rel === 'running' },
                    { name: 'WS Signal', port: data.ws_signal_port || 21118, up: sig === 'running' },
                    { name: 'WS Relay', port: data.ws_relay_port || 21119, up: rel === 'running' },
                    { name: 'API', port: data.api_port || 21114, up: true },
                    { name: 'Client API', port: data.client_api_port || 21121, up: true },
                    { name: 'Console', port: data.console_port || 5000, up: true }
                ];
                var html = '<div class="widget-si-port-header"><span>' + t('desktop.label_service') + '</span><span>' + t('desktop.label_port') + '</span></div>';
                rows.forEach(function (r) {
                    html += '<div class="widget-si-port-row"><span class="widget-si-port-dot ' + (r.up ? 'up' : 'down') + '"></span><span class="widget-si-port-name">' + esc(r.name) + '</span><span class="widget-si-port-num">' + r.port + '</span></div>';
                });
                pc.innerHTML = html;
            }).catch(function () {});
        }
    });

    // 4. Device Stats Gauges
    register('system-stats', {
        name: t('desktop.widget_system_stats'),
        icon: 'speed',
        color: '#bc8cff',
        category: 'monitoring',
        description: 'Online, offline, and blocked device ratios',
        defaultSize: { w: 360, h: 200 },
        minSize: { w: 300, h: 160 },
        updateInterval: 10000,
        render: function (body) {
            body.innerHTML = '<div style="display:flex;gap:16px;justify-content:center;align-items:center;height:100%;">' +
                '<div class="widget-gauge" id="gauge-cpu"><div class="widget-gauge-ring">' + buildGaugeSVG(0) + '<div class="widget-gauge-value">-</div></div><div class="widget-gauge-label">' + t('desktop.label_online') + '</div></div>' +
                '<div class="widget-gauge" id="gauge-mem"><div class="widget-gauge-ring">' + buildGaugeSVG(0) + '<div class="widget-gauge-value">-</div></div><div class="widget-gauge-label">' + t('desktop.label_offline') + '</div></div>' +
                '<div class="widget-gauge" id="gauge-disk"><div class="widget-gauge-ring">' + buildGaugeSVG(0) + '<div class="widget-gauge-value">-</div></div><div class="widget-gauge-label">' + t('desktop.label_blocked') + '</div></div>' +
            '</div>';
        },
        update: function (body) {
            apiGet('/api/stats').then(function (data) {
                if (!data || !data.devices) return;
                var d = data.devices;
                var total = d.total || 1;
                var onlinePct = Math.round(((d.online || 0) / total) * 100);
                var offlinePct = Math.round(((d.offline || 0) / total) * 100);
                var blockedPct = Math.round(((d.banned || d.blocked || 0) / total) * 100);
                _updateGauge(body, 'gauge-cpu', onlinePct);
                _updateGauge(body, 'gauge-mem', offlinePct);
                _updateGauge(body, 'gauge-disk', blockedPct);
            }).catch(function () {});
        }
    });

    function _updateGauge(body, id, pct) {
        var gauge = body.querySelector('#' + id);
        if (!gauge) return;
        var ring = gauge.querySelector('.widget-gauge-ring');
        var val  = gauge.querySelector('.widget-gauge-value');
        if (ring) {
            // Replace SVG
            var svg = ring.querySelector('svg');
            var newRing = document.createElement('div');
            newRing.innerHTML = buildGaugeSVG(pct);
            if (svg) ring.replaceChild(newRing.firstChild, svg);
        }
        if (val) val.textContent = Math.round(pct) + '%';
    }

    // 5. Device List (mini table)
    register('device-list', {
        name: t('desktop.widget_device_list'),
        icon: 'list',
        color: '#79c0ff',
        category: 'devices',
        description: 'Scrollable list of all devices',
        defaultSize: { w: 360, h: 300 },
        minSize: { w: 280, h: 200 },
        updateInterval: 20000,
        render: function (body) {
            body.innerHTML = '<div class="widget-device-list"><div class="widget-loading" style="height:40px"></div></div>';
            body.style.overflow = 'auto';
        },
        update: function (body) {
            apiGet('/api/devices').then(function (data) {
                var peers = [];
                if (data && data.devices) peers = data.devices;
                else if (Array.isArray(data)) peers = data;
                if (!peers.length) return;

                var list = body.querySelector('.widget-device-list');
                if (!list) return;
                if (!peers.length) {
                    list.innerHTML = '<div class="widget-empty"><span class="material-icons">devices</span><span>' + t('desktop.label_no_devices') + '</span></div>';
                    return;
                }

                var html = '';
                peers.slice(0, 50).forEach(function (p) {
                    var online = p.live_online || p.online || false;
                    var status = online ? 'online' : 'offline';
                    html += '<div class="widget-device-row">' +
                        '<div class="widget-device-dot ' + status + '"></div>' +
                        '<div class="widget-device-id">' + esc(p.id) + '</div>' +
                        '<div class="widget-device-name">' + esc(p.hostname || p.name || '-') + '</div>' +
                        '<div class="widget-device-platform">' + esc(p.platform || p.os || '') + '</div>' +
                    '</div>';
                });
                list.innerHTML = html;
            }).catch(function () {});
        }
    });

    // 6. Quick Actions
    register('quick-actions', {
        name: t('desktop.widget_quick_actions'),
        icon: 'flash_on',
        color: '#d29922',
        category: 'tools',
        description: 'Common management shortcuts',
        defaultSize: { w: 260, h: 210 },
        minSize: { w: 200, h: 160 },
        render: function (body) {
            var actions = [
                { icon: 'add', label: t('desktop.action_add_widget'), action: 'add-widget', color: '#58a6ff' },
                { icon: 'wallpaper', label: t('desktop.wallpaper'), action: 'wallpaper', color: '#bc8cff' },
                { icon: 'devices', label: t('nav.devices'), action: 'nav', route: '/devices', color: '#3fb950' },
                { icon: 'dashboard', label: t('nav.dashboard'), action: 'nav', route: '/', color: '#f0883e' },
                { icon: 'vpn_key', label: t('nav.keys'), action: 'nav', route: '/keys', color: '#d29922' },
                { icon: 'settings', label: t('nav.settings'), action: 'nav', route: '/settings', color: '#8b949e' }
            ];

            var html = '<div class="widget-actions-grid">';
            actions.forEach(function (a) {
                html += '<div class="widget-action-btn" data-action="' + esc(a.action) + '" data-route="' + esc(a.route || '') + '">' +
                    '<span class="material-icons" style="color:' + esc(a.color) + '">' + esc(a.icon) + '</span>' +
                    '<span>' + esc(a.label) + '</span>' +
                '</div>';
            });
            html += '</div>';
            body.innerHTML = html;

            body.querySelectorAll('.widget-action-btn').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    var action = btn.dataset.action;
                    if (action === 'nav' && btn.dataset.route) {
                        window.location.href = btn.dataset.route;
                    } else if (action === 'wallpaper' && window.DesktopWidgets) {
                        window.DesktopWidgets.openWallpaperPicker();
                    } else if (action === 'add-widget' && window.DesktopWidgets) {
                        window.DesktopWidgets.openPicker();
                    }
                });
            });
        }
    });

    // 7. Recent Activity (feed)
    register('recent-activity', {
        name: t('desktop.widget_recent_activity'),
        icon: 'history',
        color: '#f778ba',
        category: 'monitoring',
        description: 'Latest audit events',
        defaultSize: { w: 320, h: 280 },
        minSize: { w: 240, h: 180 },
        updateInterval: 15000,
        render: function (body) {
            body.innerHTML = '<div class="widget-feed-list"><div class="widget-loading" style="height:40px"></div></div>';
            body.style.overflow = 'auto';
        },
        update: function (body) {
            apiGet('/api/audit/conn?limit=20').then(function (data) {
                var events = data;
                if (data && data.data) events = data.data;
                if (!Array.isArray(events)) return;

                var list = body.querySelector('.widget-feed-list');
                if (!list) return;
                if (!events.length) {
                    list.innerHTML = '<div class="widget-empty"><span class="material-icons">history</span><span>' + t('desktop.label_no_activity') + '</span></div>';
                    return;
                }

                var html = '';
                events.slice(0, 15).forEach(function (ev) {
                    var time = ev.created_at || ev.timestamp || '';
                    html += '<div class="widget-feed-item">' +
                        '<div class="widget-feed-time">' + esc(timeSince(time)) + '</div>' +
                        '<div class="widget-feed-text">' + esc(ev.action || ev.event_type || '') + ' — ' + esc(ev.details || ev.description || '') + '</div>' +
                    '</div>';
                });
                list.innerHTML = html;
            }).catch(function () {});
        }
    });

    // 8. Notes (sticky)
    register('notes', {
        name: t('desktop.widget_notes'),
        icon: 'sticky_note_2',
        color: '#d29922',
        category: 'general',
        description: 'Personal sticky note',
        defaultSize: { w: 260, h: 240 },
        minSize: { w: 180, h: 140 },
        render: function (body, config) {
            body.innerHTML = '<textarea class="widget-notes-textarea" placeholder="' + esc(t('desktop.notes_placeholder')) + '"></textarea>';
            var ta = body.querySelector('.widget-notes-textarea');
            ta.value = config.text || '';
            var debounce = null;
            ta.addEventListener('input', function () {
                clearTimeout(debounce);
                debounce = setTimeout(function () {
                    config.text = ta.value;
                    // Trigger layout save through widget engine
                    if (window.DesktopWidgets && window.DesktopWidgets.getWidgets) {
                        // save is triggered by config change
                        localStorage.setItem('bd_widget_layout', JSON.stringify(
                            Array.from(window.DesktopWidgets.getWidgets().values())
                        ));
                    }
                }, 500);
            });
        },
        configForm: function (config) {
            return [
                { key: 'text', label: 'Note text', type: 'textarea' }
            ];
        }
    });

    // 9. Network Monitor
    register('network-monitor', {
        name: t('desktop.widget_network_monitor'),
        icon: 'wifi',
        color: '#3fb950',
        category: 'monitoring',
        description: 'Network target ping status',
        defaultSize: { w: 300, h: 240 },
        minSize: { w: 240, h: 180 },
        updateInterval: 30000,
        render: function (body) {
            body.innerHTML = '<div class="widget-net-targets"><div class="widget-loading" style="height:40px"></div></div>';
        },
        update: function (body) {
            apiGet('/api/network/targets').then(function (data) {
                var targets = data;
                if (data && data.data) targets = data.data;
                if (!Array.isArray(targets)) { targets = []; }

                var container = body.querySelector('.widget-net-targets');
                if (!container) return;
                if (!targets.length) {
                    container.innerHTML = '<div class="widget-empty"><span class="material-icons">wifi</span><span>' + t('desktop.label_no_targets') + '</span></div>';
                    return;
                }

                var html = '';
                targets.slice(0, 10).forEach(function (tgt) {
                    var status = tgt.is_up ? 'up' : 'down';
                    html += '<div class="widget-net-target">' +
                        '<div class="widget-net-status ' + status + '"></div>' +
                        '<div class="widget-net-name">' + esc(tgt.name || tgt.host) + '</div>' +
                        '<div class="widget-net-latency">' + (tgt.avg_latency != null ? tgt.avg_latency + 'ms' : '-') + '</div>' +
                    '</div>';
                });
                container.innerHTML = html;
            }).catch(function () {
                var container = body.querySelector('.widget-net-targets');
                if (container) container.innerHTML = '<div class="widget-empty"><span class="material-icons">wifi_off</span><span>' + t('desktop.label_unavailable') + '</span></div>';
            });
        }
    });

    // 10. Tickets Summary
    register('tickets-summary', {
        name: t('desktop.widget_tickets_summary'),
        icon: 'confirmation_number',
        color: '#f85149',
        category: 'tools',
        description: 'Open and resolved ticket counts',
        defaultSize: { w: 260, h: 190 },
        minSize: { w: 200, h: 150 },
        updateInterval: 30000,
        render: function (body) {
            body.innerHTML = '<div>' +
                '<div class="widget-tickets-row"><span class="widget-tickets-label">' + t('desktop.label_open') + '</span><span class="widget-tickets-count" style="color:#f85149" id="tickets-open">-</span></div>' +
                '<div class="widget-tickets-row"><span class="widget-tickets-label">' + t('desktop.label_in_progress') + '</span><span class="widget-tickets-count" style="color:#d29922" id="tickets-progress">-</span></div>' +
                '<div class="widget-tickets-row"><span class="widget-tickets-label">' + t('desktop.label_resolved') + '</span><span class="widget-tickets-count" style="color:#3fb950" id="tickets-resolved">-</span></div>' +
            '</div>';
        },
        update: function (body) {
            apiGet('/api/tickets/stats').then(function (data) {
                if (!data) return;
                var open = body.querySelector('#tickets-open');
                var prog = body.querySelector('#tickets-progress');
                var res  = body.querySelector('#tickets-resolved');
                if (open) open.textContent = data.open_count || data.open || 0;
                if (prog) prog.textContent = data.in_progress_count || data.in_progress || 0;
                if (res)  res.textContent = data.resolved_count || data.resolved || 0;
            }).catch(function () {});
        }
    });

    // 11. iFrame
    register('iframe', {
        name: t('desktop.widget_iframe'),
        icon: 'language',
        color: '#8b949e',
        category: 'general',
        description: 'Embed any URL in a widget',
        defaultSize: { w: 400, h: 300 },
        minSize: { w: 200, h: 150 },
        render: function (body, config) {
            var url = config.url || '';
            if (url) {
                body.style.padding = '0';
                body.innerHTML = '<iframe class="widget-iframe" src="' + esc(url) + '" sandbox="allow-same-origin allow-scripts"></iframe>';
            } else {
                body.innerHTML = '<div class="widget-empty"><span class="material-icons">language</span><span>' + t('desktop.label_set_url') + '</span></div>';
            }
        },
        configForm: function (config) {
            return [
                { key: 'url', label: 'URL', type: 'text' }
            ];
        }
    });

    // 12. CDAP Integration Widget
    register('cdap-devices', {
        name: t('desktop.widget_cdap_devices'),
        icon: 'developer_board',
        color: '#bc8cff',
        category: 'devices',
        description: 'Connected CDAP devices & widgets',
        defaultSize: { w: 320, h: 260 },
        minSize: { w: 240, h: 180 },
        updateInterval: 15000,
        render: function (body) {
            body.innerHTML = '<div class="widget-device-list"><div class="widget-loading" style="height:40px"></div></div>';
            body.style.overflow = 'auto';
        },
        update: function (body) {
            apiGet('/api/cdap/devices').then(function (data) {
                var devices = data;
                if (data && data.data) devices = data.data;
                if (!Array.isArray(devices)) devices = [];

                var list = body.querySelector('.widget-device-list');
                if (!list) return;
                if (!devices.length) {
                    list.innerHTML = '<div class="widget-empty"><span class="material-icons">developer_board</span><span>' + t('desktop.label_no_cdap_devices') + '</span></div>';
                    return;
                }

                var html = '';
                devices.forEach(function (d) {
                    var status = d.connected ? 'online' : 'offline';
                    html += '<div class="widget-device-row">' +
                        '<div class="widget-device-dot ' + status + '"></div>' +
                        '<div class="widget-device-id">' + esc(d.id || d.device_id || '') + '</div>' +
                        '<div class="widget-device-name">' + esc(d.name || d.hostname || '-') + '</div>' +
                        '<div class="widget-device-platform">' + esc(d.type || d.device_type || '') + '</div>' +
                    '</div>';
                });
                list.innerHTML = html;
            }).catch(function () {
                var list = body.querySelector('.widget-device-list');
                if (list) list.innerHTML = '<div class="widget-empty"><span class="material-icons">developer_board</span><span>' + t('desktop.label_unavailable') + '</span></div>';
            });
        }
    });

    // ============ 13. Uptime Timer ============

    register('uptime', {
        name: t('desktop.widget_uptime'),
        icon: 'timer',
        color: '#58a6ff',
        category: 'monitoring',
        description: 'Server uptime counter',
        defaultSize: { w: 200, h: 160 },
        minSize: { w: 160, h: 120 },
        render: function (body) {
            body.innerHTML = '<div class="widget-uptime">' +
                '<div class="widget-uptime-value">--:--:--</div>' +
                '<div class="widget-uptime-label">' + t('desktop.label_server_uptime') + '</div></div>';
            body._uptimeStart = null;
            body._uptimeBase = 0;
            var self = this;
            this._fetch(body);
            body._uptimeTimer = setInterval(function () { self._tick(body); }, 1000);
        },
        _fetch: function (body) {
            apiGet('/api/server/status').then(function (d) {
                if (d && d.uptime) { body._uptimeBase = parseInt(d.uptime, 10) || 0; body._uptimeStart = Date.now(); }
                else if (d && d.started_at) { body._uptimeStart = Date.now(); body._uptimeBase = Math.floor((Date.now() - new Date(d.started_at).getTime()) / 1000); }
            }).catch(function () {});
        },
        _tick: function (body) {
            var s = body._uptimeBase;
            if (body._uptimeStart) s = body._uptimeBase + Math.floor((Date.now() - body._uptimeStart) / 1000);
            if (!s && s !== 0) return;
            var h = String(Math.floor(s / 3600)).padStart(2, '0');
            var m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
            var sec = String(s % 60).padStart(2, '0');
            var el = body.querySelector('.widget-uptime-value');
            if (el) el.textContent = h + ':' + m + ':' + sec;
        },
        update: function (body) { this._fetch(body); },
        destroy: function (body) {
            if (body && body._uptimeTimer) { clearInterval(body._uptimeTimer); body._uptimeTimer = null; }
        }
    });

    // ============ 14. Port Status Table ============

    // ============ 14. Port Status (deprecated — merged into server-health) ============

    register('port-status', {
        name: t('desktop.widget_port_status'),
        icon: 'lan',
        color: '#79c0ff',
        category: 'monitoring',
        description: 'Network port status (use Server Info instead)',
        defaultSize: { w: 380, h: 220 },
        minSize: { w: 300, h: 160 },
        updateInterval: 20000,
        render: function (body) {
            body.innerHTML = '<div class="widget-empty"><span class="material-icons">info</span><span>' + t('desktop.label_merged_server_info') + '</span></div>';
        },
        update: function () {}
    });

    // ============ 15. Device Icon Grid ============

    register('device-grid', {
        name: t('desktop.widget_device_grid'),
        icon: 'grid_view',
        color: '#3fb950',
        category: 'devices',
        description: 'Device icons with status indicators',
        defaultSize: { w: 340, h: 240 },
        minSize: { w: 260, h: 160 },
        updateInterval: 15000,
        render: function (body) {
            body.innerHTML = '<div class="widget-device-grid-container"><div class="widget-loading" style="height:40px"></div></div>';
        },
        update: function (body) {
            apiGet('/api/devices').then(function (data) {
                var peers = data && data.devices ? data.devices : (Array.isArray(data) ? data : []);
                var c = body.querySelector('.widget-device-grid-container');
                if (!c) return;
                if (!peers.length) {
                    c.innerHTML = '<div class="widget-empty"><span class="material-icons">devices</span><span>' + t('desktop.label_no_devices') + '</span></div>';
                    return;
                }
                var pi = { windows: 'laptop_windows', linux: 'computer', mac: 'laptop_mac', macos: 'laptop_mac', android: 'phone_android', ios: 'phone_iphone' };
                var html = '';
                peers.slice(0, 24).forEach(function (p) {
                    var on = p.live_online || p.online || false;
                    var plat = (p.platform || p.os || '').toLowerCase();
                    var icon = 'devices';
                    for (var k in pi) { if (plat.indexOf(k) !== -1) { icon = pi[k]; break; } }
                    html += '<div class="widget-dg-card ' + (on ? 'online' : 'offline') + '" title="' + esc(p.id + ' — ' + (p.hostname || '')) + '">' +
                        '<span class="material-icons widget-dg-icon">' + icon + '</span>' +
                        '<div class="widget-dg-name">' + esc(p.hostname || p.id || '-') + '</div>' +
                        '<div class="widget-dg-status">' + (on ? t('desktop.label_online') : t('desktop.label_offline')) + '</div></div>';
                });
                c.innerHTML = html;
            }).catch(function () {});
        }
    });

    // ============ 16. Multi-Gauge Cluster ============

    register('multi-gauge', {
        name: t('desktop.widget_multi_gauge'),
        icon: 'donut_large',
        color: '#f0883e',
        category: 'monitoring',
        description: 'Multiple resource gauges',
        defaultSize: { w: 400, h: 180 },
        minSize: { w: 320, h: 140 },
        updateInterval: 10000,
        render: function (body) {
            var names = [t('desktop.label_online'), t('desktop.label_offline'), t('desktop.label_banned'), t('desktop.label_active'), t('desktop.label_total')];
            var html = '<div class="widget-multi-gauge">';
            names.forEach(function (n, i) {
                html += '<div class="widget-mg-item" data-idx="' + i + '">' +
                    '<div class="widget-mg-ring">' + buildGaugeSVG(0, 64) + '<div class="widget-mg-value">-</div></div>' +
                    '<div class="widget-mg-label">' + n + '</div></div>';
            });
            body.innerHTML = html + '</div>';
        },
        update: function (body) {
            apiGet('/api/stats').then(function (data) {
                if (!data || !data.devices) return;
                var d = data.devices;
                var t = d.total || 1;
                var vals = [
                    { idx: 0, pct: Math.round(((d.online || 0) / t) * 100), raw: d.online || 0 },
                    { idx: 1, pct: Math.round(((d.offline || 0) / t) * 100), raw: d.offline || 0 },
                    { idx: 2, pct: Math.round(((d.banned || 0) / t) * 100), raw: d.banned || 0 },
                    { idx: 3, pct: Math.round(((d.withNotes || 0) / t) * 100), raw: d.withNotes || 0 },
                    { idx: 4, pct: 100, raw: d.total || 0 }
                ];
                vals.forEach(function (v) {
                    var item = body.querySelector('[data-idx="' + v.idx + '"]');
                    if (!item) return;
                    var ring = item.querySelector('.widget-mg-ring');
                    var val = item.querySelector('.widget-mg-value');
                    if (ring) {
                        var svg = ring.querySelector('svg');
                        var tmp = document.createElement('div');
                        tmp.innerHTML = buildGaugeSVG(v.pct, 64);
                        if (svg && tmp.firstChild) ring.replaceChild(tmp.firstChild, svg);
                    }
                    if (val) val.textContent = v.raw;
                });
            }).catch(function () {});
        }
    });

    // ============ 17. Weekly Activity Chart ============

    register('weekly-chart', {
        name: t('desktop.widget_weekly_chart'),
        icon: 'bar_chart',
        color: '#bc8cff',
        category: 'monitoring',
        description: 'Daily device activity bars',
        defaultSize: { w: 340, h: 200 },
        minSize: { w: 260, h: 160 },
        updateInterval: 60000,
        render: function (body) {
            body.innerHTML = '<div class="widget-weekly"><div class="widget-weekly-bars"></div></div>';
            this._draw(body);
        },
        _draw: function (body) {
            var c = body.querySelector('.widget-weekly-bars');
            if (!c) return;
            var days = [t('time.day_mon'), t('time.day_tue'), t('time.day_wed'), t('time.day_thu'), t('time.day_fri'), t('time.day_sat'), t('time.day_sun')];
            var dow = new Date().getDay();
            var todayIdx = dow === 0 ? 6 : dow - 1;
            var html = '';
            days.forEach(function (d, i) {
                var h1 = 30 + (i * 13) % 60;
                var h2 = 20 + ((i + 3) * 17) % 50;
                html += '<div class="widget-wb-col">' +
                    '<div class="widget-wb-bars">' +
                        '<div class="widget-wb-bar online" style="height:' + h1 + '%"></div>' +
                        '<div class="widget-wb-bar offline" style="height:' + h2 + '%"></div>' +
                    '</div>' +
                    '<div class="widget-wb-label' + (i === todayIdx ? ' today' : '') + '">' + d + '</div></div>';
            });
            c.innerHTML = html;
        },
        update: function (body) { this._draw(body); }
    });

    // ============ 18. Quick Controls ============

    register('quick-controls', {
        name: t('desktop.widget_quick_controls'),
        icon: 'tune',
        color: '#d29922',
        category: 'devices',
        description: 'Device management shortcuts',
        defaultSize: { w: 400, h: 280 },
        minSize: { w: 300, h: 200 },
        updateInterval: 15000,
        render: function (body) {
            body.innerHTML = '<div class="widget-qc"><div class="widget-qc-filter">' +
                '<input type="text" class="widget-qc-search" placeholder="' + t('desktop.label_filter_devices') + '">' +
                '<div class="widget-qc-pills">' +
                    '<button class="widget-qc-pill active" data-filter="all">' + t('desktop.label_all') + '</button>' +
                    '<button class="widget-qc-pill" data-filter="online">' + t('desktop.label_online') + '</button>' +
                    '<button class="widget-qc-pill" data-filter="offline">' + t('desktop.label_offline') + '</button>' +
                '</div></div>' +
                '<div class="widget-qc-list"><div class="widget-loading" style="height:40px"></div></div></div>';
            // Filter pills
            body.querySelector('.widget-qc-pills').addEventListener('click', function (e) {
                var pill = e.target.closest('.widget-qc-pill');
                if (!pill) return;
                body.querySelectorAll('.widget-qc-pill').forEach(function (p) { p.classList.remove('active'); });
                pill.classList.add('active');
                _filterQC(body);
            });
            // Search
            body.querySelector('.widget-qc-search').addEventListener('input', function () { _filterQC(body); });
        },
        update: function (body) {
            apiGet('/api/devices').then(function (data) {
                var peers = (data && data.devices ? data.devices : []);
                var c = body.querySelector('.widget-qc-list');
                if (!c) return;
                if (!peers.length) {
                    c.innerHTML = '<div class="widget-empty"><span class="material-icons">devices</span><span>' + t('desktop.label_no_devices') + '</span></div>';
                    return;
                }
                var pi = { windows: 'laptop_windows', linux: 'computer', mac: 'laptop_mac', macos: 'laptop_mac', android: 'phone_android', ios: 'phone_iphone' };
                var html = '';
                peers.forEach(function (p) {
                    var on = p.live_online || p.online || false;
                    var banned = p.banned || false;
                    var plat = (p.platform || p.os || '').toLowerCase();
                    var icon = 'devices';
                    for (var k in pi) { if (plat.indexOf(k) !== -1) { icon = pi[k]; break; } }
                    var name = p.hostname || p.id || '-';
                    html += '<div class="widget-qc-row' + (on ? ' online' : ' offline') + (banned ? ' banned' : '') + '" data-id="' + esc(p.id) + '" data-status="' + (on ? 'online' : 'offline') + '" data-name="' + esc(name.toLowerCase()) + '">' +
                        '<span class="material-icons widget-qc-icon">' + icon + '</span>' +
                        '<div class="widget-qc-info">' +
                            '<div class="widget-qc-name">' + esc(name) + '</div>' +
                            '<div class="widget-qc-id">' + esc(p.id) + (banned ? ' <span class="widget-qc-badge ban">' + t('desktop.label_banned') + '</span>' : '') + '</div>' +
                        '</div>' +
                        '<div class="widget-qc-actions">' +
                            '<button class="widget-qc-btn" data-action="toggle-ban" title="' + (banned ? t('desktop.label_unban') : t('desktop.label_ban')) + '"><span class="material-icons">' + (banned ? 'lock_open' : 'block') + '</span></button>' +
                            (on ? '<button class="widget-qc-btn connect" data-action="connect" title="' + t('desktop.label_connect') + '"><span class="material-icons">launch</span></button>' : '') +
                        '</div></div>';
                });
                c.innerHTML = html;
                _filterQC(body);
                // Action handlers
                c.querySelectorAll('.widget-qc-btn').forEach(function (btn) {
                    btn.addEventListener('click', function (e) {
                        e.stopPropagation();
                        var row = btn.closest('.widget-qc-row');
                        var id = row ? row.dataset.id : '';
                        var action = btn.dataset.action;
                        if (action === 'connect' && id) {
                            window.open('rustdesk://' + id, '_blank');
                        } else if (action === 'toggle-ban' && id) {
                            var isBanned = row.classList.contains('banned');
                            var url = '/api/devices/' + encodeURIComponent(id) + (isBanned ? '/unban' : '/ban');
                            fetch(url, { method: 'POST', headers: { 'X-CSRF-Token': (window.BetterDesk || {}).csrfToken || '' } })
                                .then(function () { btn.closest('.widget-qc-row').classList.toggle('banned'); })
                                .catch(function () {});
                        }
                    });
                });
            }).catch(function () {});
        }
    });

    function _filterQC(body) {
        var search = (body.querySelector('.widget-qc-search') || {}).value || '';
        search = search.toLowerCase();
        var activePill = body.querySelector('.widget-qc-pill.active');
        var filter = activePill ? activePill.dataset.filter : 'all';
        body.querySelectorAll('.widget-qc-row').forEach(function (row) {
            var matchFilter = filter === 'all' || row.dataset.status === filter;
            var matchSearch = !search || (row.dataset.name || '').indexOf(search) !== -1 || (row.dataset.id || '').toLowerCase().indexOf(search) !== -1;
            row.style.display = (matchFilter && matchSearch) ? '' : 'none';
        });
    }

    // ============ 19. Bandwidth Display ============

    register('bandwidth', {
        name: t('desktop.widget_bandwidth'),
        icon: 'speed',
        color: '#58a6ff',
        category: 'monitoring',
        description: 'Relay bandwidth & session metrics',
        defaultSize: { w: 280, h: 200 },
        minSize: { w: 220, h: 160 },
        updateInterval: 10000,
        _prevBytes: 0,
        _prevTime: 0,
        render: function (body) {
            body.innerHTML = '<div class="widget-bandwidth">' +
                '<div class="widget-bw-item">' +
                    '<div class="widget-bw-header"><span class="material-icons" style="color:#3fb950">swap_vert</span><span>' + t('desktop.label_throughput') + '</span></div>' +
                    '<div class="widget-bw-value" data-bw="speed">-</div>' +
                    '<div class="widget-bw-bar"><div class="widget-bw-fill download" data-bar="speed" style="width:0%"></div></div></div>' +
                '<div class="widget-bw-item">' +
                    '<div class="widget-bw-header"><span class="material-icons" style="color:#58a6ff">cable</span><span>' + t('desktop.label_active_relays') + '</span></div>' +
                    '<div class="widget-bw-value" data-bw="relays">-</div>' +
                    '<div class="widget-bw-bar"><div class="widget-bw-fill upload" data-bar="relays" style="width:0%"></div></div></div>' +
                '<div style="display:flex;gap:12px;margin-top:4px;">' +
                    '<div class="widget-bw-stat"><span class="widget-bw-stat-label">' + t('desktop.label_total_relayed') + '</span><span class="widget-bw-stat-val" data-bw="total">-</span></div>' +
                    '<div class="widget-bw-stat"><span class="widget-bw-stat-label">' + t('desktop.label_total_bytes') + '</span><span class="widget-bw-stat-val" data-bw="bytes">-</span></div>' +
                '</div></div>';
        },
        update: function (body) {
            var self = this;
            apiGet('/api/server/bandwidth').then(function (data) {
                if (!data) return;
                var relays = data.relay_active || 0;
                var bytes = data.bytes_transferred || 0;
                var sessions = data.active_sessions || 0;
                var totalRelayed = data.total_relayed || 0;
                // Calculate speed (bytes/sec delta)
                var now = Date.now();
                var speed = 0;
                if (self._prevTime && self._prevBytes) {
                    var dt = (now - self._prevTime) / 1000;
                    if (dt > 0) speed = Math.max(0, (bytes - self._prevBytes) / dt);
                }
                self._prevBytes = bytes;
                self._prevTime = now;
                // Format speed
                var speedStr;
                if (speed >= 1073741824) speedStr = (speed / 1073741824).toFixed(1) + ' GB/s';
                else if (speed >= 1048576) speedStr = (speed / 1048576).toFixed(1) + ' MB/s';
                else if (speed >= 1024) speedStr = (speed / 1024).toFixed(1) + ' KB/s';
                else speedStr = Math.round(speed) + ' B/s';
                // Format total bytes
                var bytesStr;
                if (bytes >= 1073741824) bytesStr = (bytes / 1073741824).toFixed(1) + ' GB';
                else if (bytes >= 1048576) bytesStr = (bytes / 1048576).toFixed(1) + ' MB';
                else if (bytes >= 1024) bytesStr = (bytes / 1024).toFixed(1) + ' KB';
                else bytesStr = bytes + ' B';
                // Update DOM
                var sv = body.querySelector('[data-bw="speed"]');
                var rv = body.querySelector('[data-bw="relays"]');
                var tv = body.querySelector('[data-bw="total"]');
                var bv = body.querySelector('[data-bw="bytes"]');
                var sb = body.querySelector('[data-bar="speed"]');
                var rb = body.querySelector('[data-bar="relays"]');
                if (sv) sv.textContent = speedStr;
                if (rv) rv.textContent = relays + ' active / ' + sessions + ' sessions';
                if (tv) tv.textContent = totalRelayed;
                if (bv) bv.textContent = bytesStr;
                // Bar: speed capped at 10 MB/s for visual
                if (sb) sb.style.width = Math.min(100, (speed / 10485760) * 100) + '%';
                // Bar: relays capped at 50 for visual
                if (rb) rb.style.width = Math.min(100, (relays / 50) * 100) + '%';
            }).catch(function () {});
        }
    });

    // ============ 20. Connection Stats Table ============

    register('connection-stats', {
        name: t('desktop.widget_connection_stats'),
        icon: 'table_chart',
        color: '#8b949e',
        category: 'monitoring',
        description: 'Tabular connection statistics',
        defaultSize: { w: 380, h: 220 },
        minSize: { w: 300, h: 160 },
        updateInterval: 30000,
        render: function (body) {
            body.innerHTML = '<div class="widget-stats-table">' +
                '<div class="widget-stats-header"><span>' + t('desktop.label_metric') + '</span><span>' + t('desktop.label_count') + '</span><span>%</span></div>' +
                '<div class="widget-stats-body"><div class="widget-loading" style="height:40px"></div></div></div>';
        },
        update: function (body) {
            apiGet('/api/stats').then(function (data) {
                if (!data || !data.devices) return;
                var d = data.devices;
                var tot = d.total || 1;
                var rows = [
                    { label: t('desktop.label_total_devices'), count: d.total || 0, pct: '100%' },
                    { label: t('desktop.label_online'), count: d.online || 0, pct: Math.round(((d.online || 0) / tot) * 100) + '%' },
                    { label: t('desktop.label_offline'), count: d.offline || 0, pct: Math.round(((d.offline || 0) / tot) * 100) + '%' },
                    { label: t('desktop.label_banned'), count: d.banned || 0, pct: Math.round(((d.banned || 0) / tot) * 100) + '%' },
                    { label: t('desktop.label_with_notes'), count: d.withNotes || 0, pct: Math.round(((d.withNotes || 0) / tot) * 100) + '%' }
                ];
                var c = body.querySelector('.widget-stats-body');
                if (!c) return;
                var html = '';
                rows.forEach(function (r) {
                    html += '<div class="widget-stats-row">' +
                        '<span class="widget-stats-label">' + esc(r.label) + '</span>' +
                        '<span class="widget-stats-count">' + r.count + '</span>' +
                        '<span class="widget-stats-pct">' + r.pct + '</span></div>';
                });
                c.innerHTML = html;
            }).catch(function () {});
        }
    });

    // ============ Expose ============

    window.WidgetPlugins = {
        register: register,
        get: get,
        list: list
    };

})();
