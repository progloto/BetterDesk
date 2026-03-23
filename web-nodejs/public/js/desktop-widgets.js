/**
 * BetterDesk Console — Desktop Widget Engine
 * Manages draggable/resizable glassmorphic widgets on a wallpaper canvas.
 * Depends: desktop-mode.js (DesktopMode), Utils, _ (i18n)
 */

(function () {
    'use strict';

    // ============ Constants ============

    var GRID = 10;
    var MIN_W = 160;
    var MIN_H = 120;
    var STORAGE_LAYOUT  = 'bd_widget_layout';
    var STORAGE_WALL    = 'bd_widget_wallpaper';
    var LAYOUT_VERSION  = 3;
    var STORAGE_LAYOUT_VER = 'bd_widget_layout_ver';
    var WALLPAPER_COUNT = 125;
    var UPDATE_INTERVAL = 30000;      // 30 s default widget data refresh
    var SAVE_DEBOUNCE   = 600;

    // ============ State ============

    var _widgets    = new Map();      // id → { id, type, x, y, w, h, z, config }
    var _zCounter   = 1;
    var _focusedId  = null;
    var _canvas     = null;
    var _dragState   = null;
    var _resizeState = null;
    var _pickerOpen  = false;
    var _wallpicker  = false;
    var _updateTimers = new Map();
    var _wallpaperPath = null;

    // ============ Helpers ============

    var t = function (k) { return typeof _ === 'function' ? _(k) : k; };

    function snap(val) { return Math.round(val / GRID) * GRID; }

    function uid() {
        return 'w-' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    }

    function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

    function esc(s) {
        var d = document.createElement('div');
        d.textContent = s || '';
        return d.innerHTML;
    }

    // ============ Initialization ============

    function init() {
        _canvas = document.getElementById('widget-canvas');
        if (!_canvas) {
            _canvas = document.createElement('div');
            _canvas.id = 'widget-canvas';
            _canvas.className = 'widget-canvas';
            var shell = document.getElementById('desktop-shell');
            if (shell) shell.insertBefore(_canvas, shell.firstChild.nextSibling); // after wallpaper
        }

        _canvas.addEventListener('mousedown', function (e) {
            if (e.target === _canvas) unfocus();
        });

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        // Touch support
        document.addEventListener('touchmove', onTouchMove, { passive: false });
        document.addEventListener('touchend', onTouchEnd);

        loadWallpaper();
        loadLayout();
        renderAll();
        renderNavBar();
        renderSidebar();
        _loadDeviceSearchCache();
    }

    function destroy() {
        stopAllTimers();
        _widgets.forEach(function (w) { destroyWidget(w.id, true); });
        _widgets.clear();
        if (_canvas) _canvas.innerHTML = '';
        _focusedId = null;
        removeNavBar();
        removeSidebar();
        removeAddButton();
    }

    // ============ Wallpaper ============

    function loadWallpaper() {
        var saved = localStorage.getItem(STORAGE_WALL);
        setWallpaper(saved || '/wallpapers/1.png');
    }

    function setWallpaper(url) {
        _wallpaperPath = url;
        var el = document.querySelector('.desktop-wallpaper');
        if (!el) return;

        // Preload image before transitioning
        var img = new Image();
        img.onload = function() {
            // Create new wallpaper layer for crossfade
            var newLayer = document.createElement('div');
            newLayer.className = 'desktop-wallpaper-new';
            newLayer.style.backgroundImage = 'url("' + url + '")';
            newLayer.style.backgroundSize = 'cover';
            newLayer.style.backgroundPosition = 'center';
            el.appendChild(newLayer);

            // Trigger crossfade animation
            requestAnimationFrame(function() {
                newLayer.classList.add('fade-in');
            });

            // After transition, update main layer and remove new layer
            setTimeout(function() {
                el.style.backgroundImage = 'url("' + url + '")';
                el.style.backgroundSize = 'cover';
                el.style.backgroundPosition = 'center';
                if (newLayer.parentElement) {
                    newLayer.remove();
                }
            }, 600); // Match CSS transition duration
        };
        img.onerror = function() {
            // Fallback: set directly without transition
            el.style.backgroundImage = 'url("' + url + '")';
            el.style.backgroundSize = 'cover';
            el.style.backgroundPosition = 'center';
        };
        img.src = url;

        localStorage.setItem(STORAGE_WALL, url);
    }

    // ============ Layout Persistence ============

    function loadLayout() {
        try {
            var savedVer = parseInt(localStorage.getItem(STORAGE_LAYOUT_VER), 10) || 1;
            var raw = localStorage.getItem(STORAGE_LAYOUT);
            // Reset to default layout on version upgrade or first visit
            if (savedVer < LAYOUT_VERSION || !raw) {
                localStorage.removeItem(STORAGE_LAYOUT);
                localStorage.setItem(STORAGE_LAYOUT_VER, String(LAYOUT_VERSION));
                var defaults = getDefaultLayout();
                defaults.forEach(function (item) {
                    _widgets.set(item.id, item);
                    if (item.z > _zCounter) _zCounter = item.z;
                });
                saveLayout();
                return;
            }
            var arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return;
            arr.forEach(function (item) {
                if (item && item.id && item.type) {
                    _widgets.set(item.id, item);
                    if (item.z > _zCounter) _zCounter = item.z;
                }
            });
        } catch (_) { /* ignore corrupt data */ }
    }

    var _saveTimeout = null;
    function saveLayout() {
        clearTimeout(_saveTimeout);
        _saveTimeout = setTimeout(function () {
            var arr = [];
            _widgets.forEach(function (w) { arr.push(w); });
            localStorage.setItem(STORAGE_LAYOUT, JSON.stringify(arr));
            // Optional: save to server
            saveLayoutToServer(arr);
        }, SAVE_DEBOUNCE);
    }

    function saveLayoutToServer(arr) {
        if (!window.BetterDesk || !window.BetterDesk.csrfToken) return;
        if (typeof Utils === 'undefined' || !Utils.api) return;
        Utils.api('/api/desktop/layout', {
            method: 'POST',
            body: JSON.stringify({ widgets: arr, wallpaper: _wallpaperPath })
        }).catch(function () { /* silent — localStorage is primary */ });
    }

    // ============ Widget CRUD ============

    function addWidget(type, config) {
        var plugin = window.WidgetPlugins && window.WidgetPlugins.get(type);
        if (!plugin) return null;

        var def = plugin.defaultSize || { w: 240, h: 200 };
        var area = getCanvasArea();
        var id = uid();

        // Find open position
        var pos = findOpenPosition(def.w, def.h, area);

        var w = {
            id: id,
            type: type,
            x: pos.x,
            y: pos.y,
            w: def.w,
            h: def.h,
            z: ++_zCounter,
            config: config || {}
        };

        _widgets.set(id, w);
        renderWidget(w);
        focusWidget(id);
        saveLayout();
        startWidgetTimer(w);
        return id;
    }

    function removeWidget(id) {
        var el = document.getElementById(id);
        if (el) {
            el.classList.remove('widget-entering');
            el.classList.add('widget-leaving');
            el.addEventListener('animationend', function () { el.remove(); }, { once: true });
        }

        var plugin = getPlugin(id);
        if (plugin && plugin.destroy) {
            var body = el ? el.querySelector('.widget-body') : null;
            try { plugin.destroy(body); } catch (_) {}
        }

        stopWidgetTimer(id);
        _widgets.delete(id);
        if (_focusedId === id) _focusedId = null;
        saveLayout();
    }

    function destroyWidget(id, immediate) {
        stopWidgetTimer(id);
        var el = document.getElementById(id);
        if (el) {
            var plugin = getPlugin(id);
            if (plugin && plugin.destroy) {
                var body = el.querySelector('.widget-body');
                try { plugin.destroy(body); } catch (_) {}
            }
            el.remove();
        }
    }

    // ============ Rendering ============

    function renderAll() {
        if (!_canvas) return;
        _canvas.innerHTML = '';
        var idx = 0;
        _widgets.forEach(function (w) {
            renderWidget(w);
            // Stagger initial data fetches to avoid 429 rate limit storm
            (function (widget, delay) {
                setTimeout(function () { startWidgetTimer(widget); }, delay);
            })(w, idx * 200);
            idx++;
        });
        renderAddButton();
    }

    function renderWidget(w) {
        var plugin = window.WidgetPlugins && window.WidgetPlugins.get(w.type);
        if (!plugin) return;

        var el = document.createElement('div');
        el.className = 'desktop-widget widget-entering';
        el.id = w.id;
        el.style.left = w.x + 'px';
        el.style.top = w.y + 'px';
        el.style.width = w.w + 'px';
        el.style.height = w.h + 'px';
        el.style.zIndex = w.z;
        el.setAttribute('data-widget-type', w.type);

        var iconColor = plugin.color || '#58a6ff';

        el.innerHTML =
            '<div class="widget-header">' +
                '<div class="widget-header-icon" style="color:' + esc(iconColor) + '">' +
                    '<span class="material-icons">' + esc(plugin.icon || 'widgets') + '</span>' +
                '</div>' +
                '<div class="widget-header-title">' + esc(plugin.name || w.type) + '</div>' +
                '<div class="widget-header-actions">' +
                    '<button class="widget-btn-config" title="' + esc(t('desktop.configure')) + '">' +
                        '<span class="material-icons">settings</span>' +
                    '</button>' +
                    '<button class="widget-btn-remove" title="' + esc(t('desktop.remove_widget')) + '">' +
                        '<span class="material-icons">close</span>' +
                    '</button>' +
                '</div>' +
            '</div>' +
            '<div class="widget-body"></div>' +
            buildResizeHandles();

        // Events
        el.addEventListener('mousedown', function (e) {
            if (!e.target.closest('.widget-header-actions')) focusWidget(w.id);
        });

        // Drag via header
        var header = el.querySelector('.widget-header');
        header.addEventListener('mousedown', function (e) {
            if (e.target.closest('.widget-header-actions')) return;
            startDrag(w.id, e);
        });
        header.addEventListener('touchstart', function (e) {
            if (e.target.closest('.widget-header-actions')) return;
            startDrag(w.id, e);
        }, { passive: false });

        // Action buttons
        el.querySelector('.widget-btn-remove').addEventListener('click', function (e) {
            e.stopPropagation();
            removeWidget(w.id);
        });
        el.querySelector('.widget-btn-config').addEventListener('click', function (e) {
            e.stopPropagation();
            openWidgetConfig(w.id);
        });

        // Resize handles
        el.querySelectorAll('.widget-resize').forEach(function (handle) {
            handle.addEventListener('mousedown', function (e) {
                e.stopPropagation();
                startResize(w.id, e, handle.dataset.dir);
            });
            handle.addEventListener('touchstart', function (e) {
                e.stopPropagation();
                startResize(w.id, e, handle.dataset.dir);
            }, { passive: false });
        });

        _canvas.appendChild(el);

        // Render plugin content
        var body = el.querySelector('.widget-body');
        if (plugin.render) {
            try { plugin.render(body, w.config, w); } catch (err) {
                body.innerHTML = '<div class="widget-empty"><span class="material-icons">error</span><span>Error</span></div>';
                console.error('[Widget] render error (' + w.type + '):', err);
            }
        }
    }

    function buildResizeHandles() {
        var dirs = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
        return dirs.map(function (d) {
            return '<div class="widget-resize widget-resize-' + d + '" data-dir="' + d + '"></div>';
        }).join('');
    }

    function renderAddButton() {
        var existing = document.querySelector('.widget-add-btn');
        if (existing) existing.remove();
        // Skip FAB when topnav provides the + button
        if (document.querySelector('.widget-topnav')) return;

        var btn = document.createElement('button');
        btn.className = 'widget-add-btn';
        btn.title = t('desktop.add_widget');
        btn.innerHTML = '<span class="material-icons">add</span>';
        btn.addEventListener('click', function () { togglePicker(); });
        var shell = document.getElementById('desktop-shell');
        (shell || document.body).appendChild(btn);
    }

    function removeAddButton() {
        var btn = document.querySelector('.widget-add-btn');
        if (btn) btn.remove();
    }

    // ============ Focus ============

    function focusWidget(id) {
        if (_focusedId === id) return;
        // Unfocus previous
        if (_focusedId) {
            var prev = document.getElementById(_focusedId);
            if (prev) prev.classList.remove('widget-focused');
        }
        _focusedId = id;
        var w = _widgets.get(id);
        if (!w) return;
        w.z = ++_zCounter;
        var el = document.getElementById(id);
        if (el) {
            el.style.zIndex = w.z;
            el.classList.add('widget-focused');
        }
    }

    function unfocus() {
        if (_focusedId) {
            var el = document.getElementById(_focusedId);
            if (el) el.classList.remove('widget-focused');
            _focusedId = null;
        }
    }

    // ============ Drag ============

    function startDrag(id, e) {
        var w = _widgets.get(id);
        if (!w) return;

        var clientX, clientY;
        if (e.touches) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
            e.preventDefault();
        } else {
            clientX = e.clientX;
            clientY = e.clientY;
            e.preventDefault();
        }

        focusWidget(id);

        _dragState = {
            id: id,
            startX: clientX,
            startY: clientY,
            origX: w.x,
            origY: w.y
        };

        var el = document.getElementById(id);
        if (el) el.classList.add('widget-dragging');
    }

    function onMouseMove(e) {
        if (_dragState) handleDragMove(e.clientX, e.clientY);
        if (_resizeState) handleResizeMove(e.clientX, e.clientY);
    }

    function onTouchMove(e) {
        if (!_dragState && !_resizeState) return;
        e.preventDefault();
        var touch = e.touches[0];
        if (_dragState) handleDragMove(touch.clientX, touch.clientY);
        if (_resizeState) handleResizeMove(touch.clientX, touch.clientY);
    }

    function handleDragMove(cx, cy) {
        var s = _dragState;
        var w = _widgets.get(s.id);
        if (!w) return;

        var area = getCanvasArea();
        w.x = clamp(snap(s.origX + (cx - s.startX)), 0, area.w - w.w);
        w.y = clamp(snap(s.origY + (cy - s.startY)), 0, area.h - w.h);

        var el = document.getElementById(s.id);
        if (el) {
            el.style.left = w.x + 'px';
            el.style.top = w.y + 'px';
        }
    }

    function onMouseUp() { endInteraction(); }
    function onTouchEnd() { endInteraction(); }

    function endInteraction() {
        if (_dragState) {
            var el = document.getElementById(_dragState.id);
            if (el) el.classList.remove('widget-dragging');
            _dragState = null;
            saveLayout();
        }
        if (_resizeState) {
            var el = document.getElementById(_resizeState.id);
            if (el) el.classList.remove('widget-resizing');
            _resizeState = null;
            saveLayout();
        }
    }

    // ============ Resize ============

    function startResize(id, e, dir) {
        var w = _widgets.get(id);
        if (!w) return;

        var cx, cy;
        if (e.touches) {
            cx = e.touches[0].clientX;
            cy = e.touches[0].clientY;
            e.preventDefault();
        } else {
            cx = e.clientX;
            cy = e.clientY;
            e.preventDefault();
        }

        focusWidget(id);
        var plugin = window.WidgetPlugins && window.WidgetPlugins.get(w.type);
        var minW = (plugin && plugin.minSize && plugin.minSize.w) || MIN_W;
        var minH = (plugin && plugin.minSize && plugin.minSize.h) || MIN_H;

        _resizeState = {
            id: id,
            dir: dir,
            startX: cx,
            startY: cy,
            origX: w.x,
            origY: w.y,
            origW: w.w,
            origH: w.h,
            minW: minW,
            minH: minH
        };

        var el = document.getElementById(id);
        if (el) el.classList.add('widget-resizing');
    }

    function handleResizeMove(cx, cy) {
        var s = _resizeState;
        var w = _widgets.get(s.id);
        if (!w) return;

        var dx = cx - s.startX;
        var dy = cy - s.startY;
        var dir = s.dir;
        var nw = w.w, nh = w.h, nx = w.x, ny = w.y;

        if (dir.indexOf('e') !== -1) nw = Math.max(s.minW, snap(s.origW + dx));
        if (dir.indexOf('s') !== -1) nh = Math.max(s.minH, snap(s.origH + dy));
        if (dir.indexOf('w') !== -1) {
            var pw = snap(s.origW - dx);
            if (pw >= s.minW) { nw = pw; nx = s.origX + (s.origW - pw); }
        }
        if (dir.indexOf('n') !== -1) {
            var ph = snap(s.origH - dy);
            if (ph >= s.minH) { nh = ph; ny = s.origY + (s.origH - ph); }
        }

        w.x = nx; w.y = ny; w.w = nw; w.h = nh;

        var el = document.getElementById(s.id);
        if (el) {
            el.style.left = nx + 'px';
            el.style.top = ny + 'px';
            el.style.width = nw + 'px';
            el.style.height = nh + 'px';
        }
    }

    // ============ Widget Data Updates ============

    function startWidgetTimer(w) {
        stopWidgetTimer(w.id);
        var plugin = getPlugin(w.id);
        if (!plugin || !plugin.update) return;
        var interval = plugin.updateInterval || UPDATE_INTERVAL;

        // Immediate first update
        updateWidgetData(w.id);

        var timer = setInterval(function () { updateWidgetData(w.id); }, interval);
        _updateTimers.set(w.id, timer);
    }

    function stopWidgetTimer(id) {
        var timer = _updateTimers.get(id);
        if (timer) {
            clearInterval(timer);
            _updateTimers.delete(id);
        }
    }

    function stopAllTimers() {
        _updateTimers.forEach(function (timer) { clearInterval(timer); });
        _updateTimers.clear();
    }

    function updateWidgetData(id) {
        var w = _widgets.get(id);
        if (!w) return;
        var plugin = window.WidgetPlugins && window.WidgetPlugins.get(w.type);
        if (!plugin || !plugin.update) return;

        var el = document.getElementById(id);
        if (!el) return;
        var body = el.querySelector('.widget-body');
        if (!body) return;

        try { plugin.update(body, w.config, w); } catch (err) {
            console.error('[Widget] update error (' + w.type + '):', err);
        }
    }

    // ============ Utility ============

    function getPlugin(widgetId) {
        var w = _widgets.get(widgetId);
        if (!w) return null;
        return window.WidgetPlugins && window.WidgetPlugins.get(w.type);
    }

    function getCanvasArea() {
        if (_canvas) {
            return { w: _canvas.offsetWidth, h: _canvas.offsetHeight };
        }
        // Account for topnav (42px), sidebar (42px), taskbar (48px)
        return { w: window.innerWidth - 42, h: window.innerHeight - 42 - 48 };
    }

    function findOpenPosition(w, h, area) {
        // Simple spiral search for open spot
        for (var row = 0; row < area.h - h; row += GRID * 4) {
            for (var col = 0; col < area.w - w; col += GRID * 4) {
                if (!isOverlapping(col, row, w, h)) {
                    return { x: col + 20, y: row + 20 };
                }
            }
        }
        // Fallback: random position
        return {
            x: snap(Math.random() * Math.max(0, area.w - w)),
            y: snap(Math.random() * Math.max(0, area.h - h))
        };
    }

    function isOverlapping(x, y, w, h) {
        var found = false;
        _widgets.forEach(function (wg) {
            if (found) return;
            if (x < wg.x + wg.w && x + w > wg.x && y < wg.y + wg.h && y + h > wg.y) {
                found = true;
            }
        });
        return found;
    }

    // ============ Widget Picker ============

    function togglePicker() {
        if (_pickerOpen) {
            closePicker();
        } else {
            openPicker();
        }
    }

    function openPicker() {
        closePicker();
        _pickerOpen = true;

        if (!window.WidgetPlugins) return;
        var plugins = window.WidgetPlugins.list();

        // Group by category
        var categories = {};
        plugins.forEach(function (p) {
            var cat = p.category || 'general';
            if (!categories[cat]) categories[cat] = [];
            categories[cat].push(p);
        });

        var panel = document.createElement('div');
        panel.className = 'widget-picker';
        panel.id = 'widget-picker';

        var html = '<div class="widget-picker-header">' +
            '<h3>' + esc(t('desktop.add_widget')) + '</h3>' +
            '<div class="widget-picker-search-wrap">' +
                '<span class="material-icons">search</span>' +
                '<input class="widget-picker-search" placeholder="' + esc(t('desktop.search_widgets')) + '">' +
            '</div>' +
        '</div>' +
        '<div class="widget-picker-list">';

        var catOrder = ['monitoring', 'devices', 'tools', 'general'];
        catOrder.forEach(function (cat) {
            var items = categories[cat];
            if (!items || !items.length) return;
            html += '<div class="widget-picker-category">' + esc(t('desktop.cat_' + cat)) + '</div>';
            items.forEach(function (p) {
                html += '<div class="widget-picker-item" data-type="' + esc(p.type) + '">' +
                    '<div class="widget-picker-item-icon" style="background:' + esc(p.color || '#58a6ff') + '22;color:' + esc(p.color || '#58a6ff') + '">' +
                        '<span class="material-icons">' + esc(p.icon) + '</span>' +
                    '</div>' +
                    '<div class="widget-picker-item-info">' +
                        '<div class="widget-picker-item-name">' + esc(p.name) + '</div>' +
                        '<div class="widget-picker-item-desc">' + esc(p.description || '') + '</div>' +
                    '</div>' +
                '</div>';
            });
        });

        html += '</div>';
        panel.innerHTML = html;

        var shell = document.getElementById('desktop-shell');
        (shell || document.body).appendChild(panel);

        // Search filter
        var searchInput = panel.querySelector('.widget-picker-search');
        searchInput.addEventListener('input', function () {
            var q = searchInput.value.toLowerCase();
            panel.querySelectorAll('.widget-picker-item').forEach(function (item) {
                var name = item.querySelector('.widget-picker-item-name').textContent.toLowerCase();
                var desc = item.querySelector('.widget-picker-item-desc').textContent.toLowerCase();
                item.style.display = (name.indexOf(q) !== -1 || desc.indexOf(q) !== -1) ? '' : 'none';
            });
            // Hide empty categories
            panel.querySelectorAll('.widget-picker-category').forEach(function (cat) {
                var next = cat.nextElementSibling;
                var hasVisible = false;
                while (next && !next.classList.contains('widget-picker-category')) {
                    if (next.style.display !== 'none') hasVisible = true;
                    next = next.nextElementSibling;
                }
                cat.style.display = hasVisible ? '' : 'none';
            });
        });

        // Click handler for items
        panel.querySelectorAll('.widget-picker-item').forEach(function (item) {
            item.addEventListener('click', function () {
                addWidget(item.dataset.type);
                closePicker();
            });
        });

        // Close on outside click
        setTimeout(function () {
            function handleOutside(e) {
                if (!panel.contains(e.target) && !e.target.closest('.widget-add-btn')) {
                    closePicker();
                    document.removeEventListener('mousedown', handleOutside);
                }
            }
            document.addEventListener('mousedown', handleOutside);
        }, 10);
    }

    function closePicker() {
        _pickerOpen = false;
        var panel = document.getElementById('widget-picker');
        if (panel) panel.remove();
    }

    // ============ Widget Config Modal ============

    function openWidgetConfig(id) {
        var w = _widgets.get(id);
        if (!w) return;
        var plugin = getPlugin(id);
        if (!plugin || !plugin.configForm) return;

        var fields = plugin.configForm(w.config);
        if (!fields || !fields.length) return;

        var overlay = document.createElement('div');
        overlay.className = 'widget-config-overlay';
        overlay.id = 'widget-config-overlay';

        var html = '<div class="widget-config-panel">' +
            '<h3>' + esc(plugin.name) + ' — ' + esc(t('desktop.configure')) + '</h3>';

        fields.forEach(function (f) {
            html += '<div class="widget-config-field">';
            html += '<label>' + esc(f.label) + '</label>';
            if (f.type === 'select') {
                html += '<select name="' + esc(f.key) + '">';
                (f.options || []).forEach(function (opt) {
                    var sel = (w.config[f.key] === opt.value) ? ' selected' : '';
                    html += '<option value="' + esc(opt.value) + '"' + sel + '>' + esc(opt.label) + '</option>';
                });
                html += '</select>';
            } else if (f.type === 'textarea') {
                html += '<textarea name="' + esc(f.key) + '" rows="4">' + esc(w.config[f.key] || '') + '</textarea>';
            } else {
                html += '<input type="' + (f.type || 'text') + '" name="' + esc(f.key) + '" value="' + esc(w.config[f.key] || '') + '">';
            }
            html += '</div>';
        });

        html += '<div class="widget-config-actions">' +
            '<button class="widget-config-btn-cancel">' + esc(t('common.cancel')) + '</button>' +
            '<button class="widget-config-btn-save">' + esc(t('common.save')) + '</button>' +
        '</div></div>';

        overlay.innerHTML = html;
        var shell = document.getElementById('desktop-shell');
        (shell || document.body).appendChild(overlay);

        // Cancel
        overlay.querySelector('.widget-config-btn-cancel').addEventListener('click', function () {
            overlay.remove();
        });
        overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });

        // Save
        overlay.querySelector('.widget-config-btn-save').addEventListener('click', function () {
            fields.forEach(function (f) {
                var input = overlay.querySelector('[name="' + f.key + '"]');
                if (input) w.config[f.key] = input.value;
            });
            overlay.remove();
            saveLayout();

            // Re-render widget body
            var el = document.getElementById(id);
            if (el && plugin.render) {
                var body = el.querySelector('.widget-body');
                if (body) {
                    body.innerHTML = '';
                    try { plugin.render(body, w.config, w); } catch (_) {}
                }
            }
            // Trigger update
            updateWidgetData(id);
        });
    }

    // ============ Wallpaper Picker ============

    var _pickerObserver = null;

    function openWallpaperPicker() {
        if (_wallpicker) return;
        _wallpicker = true;

        var overlay = document.createElement('div');
        overlay.className = 'wallpaper-picker-overlay';
        overlay.id = 'wallpaper-picker-overlay';

        var html = '<div class="wallpaper-picker">' +
            '<div class="wallpaper-picker-header">' +
                '<h3>' + esc(t('desktop.wallpaper')) + '</h3>' +
                '<button class="wallpaper-picker-close"><span class="material-icons">close</span></button>' +
            '</div>' +
            '<div class="wallpaper-grid" id="wallpaper-grid"></div></div>';
        overlay.innerHTML = html;
        var shell = document.getElementById('desktop-shell');
        (shell || document.body).appendChild(overlay);

        overlay.querySelector('.wallpaper-picker-close').addEventListener('click', closeWallpaperPicker);
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeWallpaperPicker();
        });

        var grid = overlay.querySelector('#wallpaper-grid');

        // Build all placeholder divs in a single fragment (lightweight, no images yet)
        var frag = document.createDocumentFragment();
        for (var i = 1; i <= WALLPAPER_COUNT; i++) {
            var wallPath = '/wallpapers/' + i + '.png';
            var thumbPath = '/wallpapers/thumbs/' + i + '.webp';
            var active = (_wallpaperPath === wallPath) ? ' active' : '';
            var thumb = document.createElement('div');
            thumb.className = 'wallpaper-thumb' + active;
            thumb.dataset.path = wallPath;
            thumb.dataset.thumb = thumbPath;
            thumb.dataset.idx = String(i);
            thumb.innerHTML = '<div class="wallpaper-thumb-placeholder"><span>' + i + '</span></div>';
            frag.appendChild(thumb);
        }
        grid.appendChild(frag);

        // Single click handler via event delegation (instead of 125 individual listeners)
        grid.addEventListener('click', function (e) {
            var el = e.target.closest('.wallpaper-thumb');
            if (!el || !el.dataset.path) return;
            grid.querySelectorAll('.wallpaper-thumb.active').forEach(function (a) { a.classList.remove('active'); });
            el.classList.add('active');
            setWallpaper(el.dataset.path);
            closeWallpaperPicker();
        });

        // Lazy-load WebP thumbnails via IntersectionObserver
        if ('IntersectionObserver' in window) {
            _pickerObserver = new IntersectionObserver(function (entries) {
                entries.forEach(function (entry) {
                    if (!entry.isIntersecting) return;
                    var el = entry.target;
                    var ph = el.querySelector('.wallpaper-thumb-placeholder');
                    if (!ph) { _pickerObserver.unobserve(el); return; }
                    var img = document.createElement('img');
                    img.onload = function () { img.classList.add('loaded'); };
                    img.src = el.dataset.thumb;
                    img.alt = 'Wallpaper ' + el.dataset.idx;
                    img.loading = 'lazy';
                    img.decoding = 'async';
                    el.replaceChild(img, ph);
                    _pickerObserver.unobserve(el);
                });
            }, { root: grid, rootMargin: '300px' });

            grid.querySelectorAll('.wallpaper-thumb').forEach(function (el) {
                _pickerObserver.observe(el);
            });
        } else {
            // Fallback: native lazy loading (no IntersectionObserver)
            grid.querySelectorAll('.wallpaper-thumb').forEach(function (el) {
                var ph = el.querySelector('.wallpaper-thumb-placeholder');
                if (!ph) return;
                var img = document.createElement('img');
                img.onload = function () { img.classList.add('loaded'); };
                img.src = el.dataset.thumb;
                img.alt = 'Wallpaper ' + el.dataset.idx;
                img.loading = 'lazy';
                img.decoding = 'async';
                el.replaceChild(img, ph);
            });
        }
    }

    function closeWallpaperPicker() {
        _wallpicker = false;
        if (_pickerObserver) {
            _pickerObserver.disconnect();
            _pickerObserver = null;
        }
        var overlay = document.getElementById('wallpaper-picker-overlay');
        if (overlay) overlay.remove();
    }

    // ============ Navigation Bar & Sidebar ============

    function renderNavBar() {
        if (document.querySelector('.widget-topnav')) return;
        var nav = document.createElement('div');
        nav.className = 'widget-topnav';
        nav.innerHTML =
            '<button class="topnav-menu" id="topnav-menu-btn" title="Menu"><span class="material-icons">menu</span></button>' +
            '<div class="topnav-brand">BetterDesk</div>' +
            '<div class="topnav-tabs">' +
                '<button class="topnav-tab active" data-route="/" title="' + esc(t('nav.dashboard') || 'Dashboard') + '"><span class="material-icons">home</span></button>' +
                '<button class="topnav-tab" data-route="/devices" title="' + esc(t('nav.devices') || 'Devices') + '"><span class="material-icons">devices</span></button>' +
                '<button class="topnav-tab" data-route="/inventory" title="' + esc(t('inventory.title') || 'Inventory') + '"><span class="material-icons">inventory_2</span></button>' +
                '<button class="topnav-tab" data-route="/tickets" title="' + esc(t('tickets.title') || 'Helpdesk') + '"><span class="material-icons">support_agent</span></button>' +
                '<button class="topnav-tab" data-route="/automation" title="' + esc(t('automation.title') || 'Automation') + '"><span class="material-icons">smart_toy</span></button>' +
                '<button class="topnav-tab" data-route="/network" title="' + esc(t('network.title') || 'Network') + '"><span class="material-icons">wifi</span></button>' +
                '<button class="topnav-tab" data-route="/reports" title="' + esc(t('reports.title') || 'Reports') + '"><span class="material-icons">assessment</span></button>' +
                '<button class="topnav-tab" data-route="/keys" title="' + esc(t('nav.keys') || 'Keys') + '"><span class="material-icons">vpn_key</span></button>' +
                '<button class="topnav-tab" data-route="/cdap/devices" title="CDAP"><span class="material-icons">developer_board</span></button>' +
                '<button class="topnav-tab" data-route="/tokens" title="' + esc(t('nav.tokens') || 'Tokens') + '"><span class="material-icons">token</span></button>' +
                '<button class="topnav-tab" data-route="/settings" title="' + esc(t('nav.settings') || 'Settings') + '"><span class="material-icons">settings</span></button>' +
            '</div>' +
            '<div class="topnav-sep"></div>' +
            '<div class="topnav-actions">' +
                '<button class="topnav-btn" id="topnav-search" title="Search"><span class="material-icons">search</span></button>' +
                '<button class="topnav-btn" id="topnav-add" title="' + esc(t('desktop.add_widget') || 'Add Widget') + '"><span class="material-icons">add</span></button>' +
                '<button class="topnav-btn" id="topnav-edit" title="Edit"><span class="material-icons">edit</span></button>' +
                '<button class="topnav-btn" id="topnav-help" title="Help"><span class="material-icons">help_outline</span></button>' +
            '</div>' +
            '<div class="topnav-clock" id="topnav-clock"></div>' +
            '<button class="topnav-btn topnav-exit" id="topnav-exit" title="' + esc(t('desktop.exit_desktop') || 'Exit Desktop') + '"><span class="material-icons">logout</span></button>';
        var shell = document.getElementById('desktop-shell');
        if (shell) shell.appendChild(nav);
        // Tab navigation — open as float window if DesktopMode has openApp
        nav.querySelectorAll('.topnav-tab').forEach(function (tab) {
            tab.addEventListener('click', function () {
                var route = tab.dataset.route;
                if (!route) return;
                if (window.DesktopMode && typeof window.DesktopMode.openAppByRoute === 'function') {
                    window.DesktopMode.openAppByRoute(route);
                } else {
                    window.location.href = route;
                }
            });
        });
        // Add widget button
        var addBtn = nav.querySelector('#topnav-add');
        if (addBtn) addBtn.addEventListener('click', function () { togglePicker(); });
        // Edit mode toggle
        var editBtn = nav.querySelector('#topnav-edit');
        if (editBtn) editBtn.addEventListener('click', function () {
            editBtn.classList.toggle('active');
            document.body.classList.toggle('widget-edit-mode');
        });
        // Help button — start desktop tutorial
        var helpBtn = nav.querySelector('#topnav-help');
        if (helpBtn) helpBtn.addEventListener('click', function () {
            if (window.BetterDeskTutorial) window.BetterDeskTutorial.start('desktop');
        });
        // Exit desktop mode
        var exitBtn = nav.querySelector('#topnav-exit');
        if (exitBtn) exitBtn.addEventListener('click', function () {
            if (window.DesktopMode) window.DesktopMode.deactivate();
        });
        // Menu button — toggle sidebar visibility
        var menuBtn = nav.querySelector('#topnav-menu-btn');
        if (menuBtn) menuBtn.addEventListener('click', function () {
            var sb = document.querySelector('.widget-sidebar');
            if (!sb) return;
            sb.classList.toggle('sidebar-collapsed');
            menuBtn.classList.toggle('active', !sb.classList.contains('sidebar-collapsed'));
            // Adjust canvas inset
            var cn = document.querySelector('.widget-canvas');
            if (cn) cn.style.left = sb.classList.contains('sidebar-collapsed') ? '0' : '';
        });
        // Search button — open search overlay
        var searchBtn = nav.querySelector('#topnav-search');
        if (searchBtn) searchBtn.addEventListener('click', function () { _openSearchOverlay(); });
        // Start topnav clock
        _startTopnavClock();
    }

    function removeNavBar() {
        _stopTopnavClock();
        var nav = document.querySelector('.widget-topnav');
        if (nav) nav.remove();
    }

    var _topnavClockTimer = null;
    function _startTopnavClock() {
        _updateTopnavClock();
        _topnavClockTimer = setInterval(_updateTopnavClock, 1000);
    }
    function _stopTopnavClock() {
        if (_topnavClockTimer) { clearInterval(_topnavClockTimer); _topnavClockTimer = null; }
    }
    function _updateTopnavClock() {
        var el = document.getElementById('topnav-clock');
        if (!el) return;
        var now = new Date();
        var h = String(now.getHours()).padStart(2, '0');
        var m = String(now.getMinutes()).padStart(2, '0');
        el.textContent = h + ':' + m;
    }

    // ============ Search Overlay ============

    function _openSearchOverlay() {
        if (document.getElementById('widget-search-overlay')) return;
        var overlay = document.createElement('div');
        overlay.id = 'widget-search-overlay';
        overlay.className = 'widget-search-overlay';
        overlay.innerHTML =
            '<div class="ws-dialog">' +
                '<div class="ws-header">' +
                    '<span class="material-icons">search</span>' +
                    '<input id="ws-input" type="text" placeholder="' + esc(t('desktop.search_placeholder') || 'Search devices, pages, settings...') + '" autocomplete="off" />' +
                    '<button class="ws-close" id="ws-close"><span class="material-icons">close</span></button>' +
                '</div>' +
                '<div class="ws-results" id="ws-results"></div>' +
            '</div>';
        document.body.appendChild(overlay);
        var input = document.getElementById('ws-input');
        var results = document.getElementById('ws-results');
        if (input) {
            input.focus();
            input.addEventListener('input', Utils.debounce(function () { _runSearch(input.value.trim(), results); }, 200));
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Escape') _closeSearchOverlay();
            });
        }
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) _closeSearchOverlay();
        });
        var closeBtn = document.getElementById('ws-close');
        if (closeBtn) closeBtn.addEventListener('click', _closeSearchOverlay);
        // Show quick-access pages immediately
        _runSearch('', results);
    }

    function _closeSearchOverlay() {
        var o = document.getElementById('widget-search-overlay');
        if (o) o.remove();
    }

    function _runSearch(query, container) {
        if (!container) return;
        var q = (query || '').toLowerCase();
        var html = '';
        // Pages / apps
        var pages = [
            { name: 'Dashboard', icon: 'dashboard', route: '/' },
            { name: 'Devices', icon: 'devices', route: '/devices' },
            { name: 'Registrations', icon: 'how_to_reg', route: '/registrations' },
            { name: 'Keys', icon: 'vpn_key', route: '/keys' },
            { name: 'Generator', icon: 'build', route: '/generator' },
            { name: 'Users', icon: 'group', route: '/users' },
            { name: 'Audit', icon: 'monitoring', route: '/audit' },
            { name: 'Network', icon: 'wifi', route: '/network' },
            { name: 'CDAP', icon: 'developer_board', route: '/cdap/devices' },
            { name: 'Tokens', icon: 'token', route: '/tokens' },
            { name: 'Settings', icon: 'settings', route: '/settings' }
        ];
        var matchedPages = q ? pages.filter(function (p) { return p.name.toLowerCase().indexOf(q) !== -1; }) : pages;
        if (matchedPages.length) {
            html += '<div class="ws-section">' + esc(t('desktop.search_pages') || 'Pages') + '</div>';
            matchedPages.forEach(function (p) {
                html += '<div class="ws-row" data-route="' + esc(p.route) + '">' +
                    '<span class="material-icons ws-row-icon">' + p.icon + '</span>' +
                    '<span class="ws-row-text">' + esc(p.name) + '</span>' +
                '</div>';
            });
        }
        // Device search (only when there's a query)
        if (q && _deviceSearchCache && _deviceSearchCache.length) {
            var matchDev = _deviceSearchCache.filter(function (d) {
                var src = ((d.id || '') + ' ' + (d.hostname || '') + ' ' + (d.note || '')).toLowerCase();
                return src.indexOf(q) !== -1;
            }).slice(0, 8);
            if (matchDev.length) {
                html += '<div class="ws-section">' + esc(t('desktop.search_devices') || 'Devices') + '</div>';
                matchDev.forEach(function (d) {
                    html += '<div class="ws-row" data-route="/devices" data-device="' + esc(d.id) + '">' +
                        '<span class="material-icons ws-row-icon">computer</span>' +
                        '<span class="ws-row-text">' + esc(d.hostname || d.id) + '</span>' +
                        '<span class="ws-row-hint">' + esc(d.id) + '</span>' +
                    '</div>';
                });
            }
        }
        if (!html) {
            html = '<div class="ws-empty">' + esc(t('desktop.search_no_results') || 'No results') + '</div>';
        }
        container.innerHTML = html;
        // Attach click handlers
        container.querySelectorAll('.ws-row').forEach(function (row) {
            row.addEventListener('click', function () {
                var route = row.dataset.route;
                _closeSearchOverlay();
                if (route && window.DesktopMode && typeof window.DesktopMode.openAppByRoute === 'function') {
                    window.DesktopMode.openAppByRoute(route);
                } else if (route) {
                    window.location.href = route;
                }
            });
        });
    }

    // Cache devices for search (populate on init)
    var _deviceSearchCache = [];
    function _loadDeviceSearchCache() {
        var token = window.BetterDesk && window.BetterDesk.csrfToken;
        fetch('/api/devices', {
            credentials: 'same-origin',
            headers: token ? { 'x-csrf-token': token } : {}
        })
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (data) { _deviceSearchCache = Array.isArray(data) ? data : (data.devices || []); })
        .catch(function () {});
    }

    function renderSidebar() {
        if (document.querySelector('.widget-sidebar')) return;
        var sb = document.createElement('div');
        sb.className = 'widget-sidebar';
        sb.innerHTML =
            '<button class="sidebar-icon active" data-action="home" title="Dashboard"><span class="material-icons">dashboard</span></button>' +
            '<button class="sidebar-icon" data-action="add-widget" title="' + esc(t('desktop.add_widget') || 'Add Widget') + '"><span class="material-icons">add_circle</span></button>' +
            '<button class="sidebar-icon" data-action="wallpaper" title="Wallpaper"><span class="material-icons">wallpaper</span></button>' +
            '<div class="sidebar-sep"></div>' +
            '<button class="sidebar-icon" data-route="/registrations" title="' + esc(t('registrations.title') || 'Registrations') + '"><span class="material-icons">how_to_reg</span></button>' +
            '<button class="sidebar-icon" data-route="/generator" title="' + esc(t('generator.title') || 'Generator') + '"><span class="material-icons">build</span></button>' +
            '<button class="sidebar-icon" data-route="/users" title="' + esc(t('users.title') || 'Users') + '"><span class="material-icons">group</span></button>' +
            '<button class="sidebar-icon" data-route="/tenants" title="' + esc(t('tenants.title') || 'Tenants') + '"><span class="material-icons">apartment</span></button>' +
            '<div class="sidebar-sep"></div>' +
            '<button class="sidebar-icon" data-route="/inventory" title="' + esc(t('inventory.title') || 'Inventory') + '"><span class="material-icons">inventory_2</span></button>' +
            '<button class="sidebar-icon" data-route="/tickets" title="' + esc(t('tickets.title') || 'Helpdesk') + '"><span class="material-icons">support_agent</span></button>' +
            '<button class="sidebar-icon" data-route="/automation" title="' + esc(t('automation.title') || 'Automation') + '"><span class="material-icons">smart_toy</span></button>' +
            '<button class="sidebar-icon" data-route="/activity" title="' + esc(t('activity.title') || 'Activity') + '"><span class="material-icons">timeline</span></button>' +
            '<button class="sidebar-icon" data-route="/reports" title="' + esc(t('reports.title') || 'Reports') + '"><span class="material-icons">assessment</span></button>' +
            '<button class="sidebar-icon" data-route="/dataguard" title="' + esc(t('dataguard.title') || 'DataGuard') + '"><span class="material-icons">security</span></button>' +
            '<div class="sidebar-spacer"></div>' +
            '<button class="sidebar-icon" data-action="help" title="Help"><span class="material-icons">help_outline</span></button>' +
            '<button class="sidebar-icon" data-route="/settings" title="Profile"><span class="material-icons">account_circle</span></button>';
        var shell = document.getElementById('desktop-shell');
        if (shell) shell.appendChild(sb);
        sb.querySelectorAll('.sidebar-icon').forEach(function (icon) {
            icon.addEventListener('click', function () {
                var route = icon.dataset.route;
                var action = icon.dataset.action;
                if (action === 'wallpaper') {
                    openWallpaperPicker();
                } else if (action === 'add-widget') {
                    togglePicker();
                } else if (action === 'home') {
                    // Scroll widgets to top/left
                    if (_canvas) _canvas.scrollTo(0, 0);
                } else if (action === 'help') {
                    // Open docs in float window
                    if (window.DesktopMode && typeof window.DesktopMode.openAppByRoute === 'function') {
                        window.DesktopMode.openAppByRoute('/settings');
                    } else {
                        window.location.href = '/settings';
                    }
                } else if (route) {
                    if (window.DesktopMode && typeof window.DesktopMode.openAppByRoute === 'function') {
                        window.DesktopMode.openAppByRoute(route);
                    } else {
                        window.location.href = route;
                    }
                }
            });
        });
    }

    function removeSidebar() {
        var sb = document.querySelector('.widget-sidebar');
        if (sb) sb.remove();
    }

    // ============ Default HA-Inspired Layout ============

    function getDefaultLayout() {
        var c = 10, g = 10;
        var c1 = c, c2 = c1 + 310 + g, c3 = c2 + 380 + g, c4 = c3 + 360 + g;
        var r1 = 10, r2 = r1 + 250 + g, r3 = r2 + 210 + g;
        return [
            // Row 1
            { id: uid(), type: 'clock',           x: c1,  y: r1, w: 310, h: 240, z: 1, config: {} },
            { id: uid(), type: 'recent-activity',  x: c2,  y: r1, w: 380, h: 240, z: 2, config: {} },
            { id: uid(), type: 'multi-gauge',      x: c3,  y: r1, w: 360, h: 165, z: 3, config: {} },
            { id: uid(), type: 'uptime',           x: c4,  y: r1, w: 200, h: 165, z: 4, config: {} },
            { id: uid(), type: 'server-health',    x: c4 + 210, y: r1, w: 380, h: 280, z: 5, config: {} },
            // Row 2
            { id: uid(), type: 'weekly-chart',     x: c1,  y: r2, w: 310, h: 200, z: 6, config: {} },
            { id: uid(), type: 'device-grid',      x: c2,  y: r2, w: 380, h: 220, z: 7, config: {} },
            { id: uid(), type: 'bandwidth',        x: c3,  y: r2, w: 360, h: 220, z: 8, config: {} },
            // Row 3
            { id: uid(), type: 'device-status',    x: c1,  y: r3, w: 310, h: 160, z: 10, config: {} },
            { id: uid(), type: 'quick-controls',   x: c2,  y: r3, w: 380, h: 210, z: 11, config: {} },
            { id: uid(), type: 'connection-stats',  x: c3,  y: r3, w: 360, h: 210, z: 12, config: {} },
            { id: uid(), type: 'notes',            x: c4,  y: r3, w: 450, h: 210, z: 13, config: {} }
        ];
    }

    // ============ Public API ============

    window.DesktopWidgets = {
        init: init,
        destroy: destroy,
        addWidget: addWidget,
        removeWidget: removeWidget,
        setWallpaper: setWallpaper,
        openWallpaperPicker: openWallpaperPicker,
        openPicker: openPicker,
        getWidgets: function () { return _widgets; },
        removeAddButton: removeAddButton,
        renderAddButton: renderAddButton
    };

})();
