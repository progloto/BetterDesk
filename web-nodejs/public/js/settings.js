/**
 * BetterDesk Console - Settings Page
 */

(function() {
    'use strict';
    
    document.addEventListener('DOMContentLoaded', init);
    
    function init() {
        initTabs();
        initPasswordForm();
        initTotpSection();
        initBrandingSection();
        initBackendSection();
        initBackupSection();
        loadAuditLog();
        loadServerInfo();
        
        // Refresh handler
        window.addEventListener('app:refresh', loadAuditLog);
    }
    
    // ==================== Tab Navigation ====================
    
    function initTabs() {
        const tabs = document.querySelectorAll('.settings-tab');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                // Deactivate all
                tabs.forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
                
                // Activate selected
                tab.classList.add('active');
                const target = document.getElementById('tab-' + tab.dataset.tab);
                if (target) target.classList.add('active');
            });
        });
        
        // Check URL hash for direct tab navigation
        const hash = window.location.hash.replace('#', '');
        if (['branding', 'server', 'backup'].includes(hash)) {
            const tab = document.querySelector(`[data-tab="${hash}"]`);
            if (tab) tab.click();
        }
    }
    
    /**
     * Initialize password change form
     */
    function initPasswordForm() {
        const form = document.getElementById('password-form');
        const newPassword = document.getElementById('new-password');
        
        if (!form) return;
        
        // Real-time password validation
        newPassword?.addEventListener('input', () => {
            validatePassword(newPassword.value);
        });
        
        // Form submission
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const currentPassword = document.getElementById('current-password').value;
            const newPass = document.getElementById('new-password').value;
            const confirmPass = document.getElementById('confirm-password').value;
            
            // Validation
            if (!currentPassword || !newPass || !confirmPass) {
                Notifications.error(_('settings.fill_all_fields'));
                return;
            }
            
            if (newPass !== confirmPass) {
                Notifications.error(_('settings.passwords_not_match'));
                return;
            }
            
            if (!validatePassword(newPass)) {
                Notifications.error(_('settings.password_requirements_not_met'));
                return;
            }
            
            try {
                await Utils.api('/api/auth/password', {
                    method: 'POST',
                    body: {
                        current_password: currentPassword,
                        new_password: newPass
                    }
                });
                
                Notifications.success(_('settings.password_changed'));
                form.reset();
                
                // Reset validation indicators
                document.querySelectorAll('.password-requirements li').forEach(li => {
                    li.classList.remove('valid');
                });
                
            } catch (error) {
                Notifications.error(error.message || _('errors.password_change_failed'));
            }
        });
    }
    
    /**
     * Validate password and update UI indicators
     */
    function validatePassword(password) {
        const requirements = {
            'req-length': password.length >= 8,
            'req-uppercase': /[A-Z]/.test(password),
            'req-lowercase': /[a-z]/.test(password),
            'req-number': /[0-9]/.test(password)
        };
        
        let allMet = true;
        
        for (const [id, met] of Object.entries(requirements)) {
            const el = document.getElementById(id);
            if (el) {
                el.classList.toggle('valid', met);
            }
            if (!met) allMet = false;
        }
        
        return allMet;
    }
    
    /**
     * Load audit log
     */
    async function loadAuditLog() {
        const tbody = document.getElementById('audit-log-body');
        if (!tbody) return;
        
        try {
            const logs = await Utils.api('/api/settings/audit');
            
            if (!logs || logs.length === 0) {
                tbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted">${_('settings.no_audit_logs')}</td></tr>`;
                return;
            }
            
            tbody.innerHTML = logs.map(log => `
                <tr>
                    <td>${Utils.formatDate(log.created_at)}</td>
                    <td>${Utils.escapeHtml(log.username || '-')}</td>
                    <td><span class="audit-action ${log.action}">${Utils.escapeHtml(log.action)}</span></td>
                    <td>${Utils.escapeHtml(log.details || '-')}</td>
                </tr>
            `).join('');
            
        } catch (error) {
            tbody.innerHTML = `<tr><td colspan="4" class="text-center text-danger">${_('errors.load_audit_failed')}</td></tr>`;
        }
    }
    
    /**
     * Load server info
     */
    async function loadServerInfo() {
        try {
            const data = await Utils.api('/api/settings/info');
            
            document.getElementById('db-path').textContent = data.paths?.database || '-';
            document.getElementById('uptime').textContent = formatUptime(data.server?.uptime);
            
        } catch (error) {
            console.error('Failed to load server info:', error);
        }
    }
    
    /**
     * Format uptime in human-readable format
     */
    function formatUptime(seconds) {
        if (!seconds || seconds < 0) return '-';
        
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        
        const parts = [];
        if (days > 0) parts.push(`${days}d`);
        if (hours > 0) parts.push(`${hours}h`);
        if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);
        
        return parts.join(' ');
    }
    
    // ==================== TOTP (2FA) Section ====================
    
    /**
     * Initialize TOTP section
     */
    async function initTotpSection() {
        const container = document.getElementById('totp-status-container');
        if (!container) return;
        
        try {
            const data = await Utils.api('/api/auth/totp/status');
            
            if (data.enabled) {
                renderTotpEnabled(container);
            } else {
                renderTotpDisabled(container);
            }
        } catch (error) {
            container.innerHTML = `<p class="text-danger">${_('errors.server_error')}</p>`;
        }
    }
    
    /**
     * Render TOTP enabled state
     */
    function renderTotpEnabled(container) {
        container.innerHTML = `
            <div class="totp-status totp-enabled">
                <div class="totp-status-badge">
                    <span class="material-icons">verified_user</span>
                    <span>${_('settings.totp_enabled')}</span>
                </div>
                <p class="totp-status-desc">${_('settings.totp_enabled_desc')}</p>
                <button class="btn btn-danger" id="totp-disable-btn">
                    <span class="material-icons">lock_open</span>
                    ${_('settings.totp_disable')}
                </button>
            </div>
        `;
        
        document.getElementById('totp-disable-btn')?.addEventListener('click', handleDisableTotp);
    }
    
    /**
     * Render TOTP disabled state
     */
    function renderTotpDisabled(container) {
        container.innerHTML = `
            <div class="totp-status totp-disabled">
                <div class="totp-status-badge disabled">
                    <span class="material-icons">shield</span>
                    <span>${_('settings.totp_disabled')}</span>
                </div>
                <p class="totp-status-desc">${_('settings.totp_disabled_desc')}</p>
                <button class="btn btn-primary" id="totp-setup-btn">
                    <span class="material-icons">qr_code_2</span>
                    ${_('settings.totp_setup')}
                </button>
            </div>
        `;
        
        document.getElementById('totp-setup-btn')?.addEventListener('click', handleSetupTotp);
    }
    
    /**
     * Handle TOTP setup flow
     */
    async function handleSetupTotp() {
        const container = document.getElementById('totp-status-container');
        
        try {
            const data = await Utils.api('/api/auth/totp/setup', { method: 'POST' });
            
            container.innerHTML = `
                <div class="totp-setup">
                    <div class="totp-setup-steps">
                        <div class="totp-step">
                            <span class="step-number">1</span>
                            <span>${_('settings.totp_step1')}</span>
                        </div>
                        <div class="totp-step">
                            <span class="step-number">2</span>
                            <span>${_('settings.totp_step2')}</span>
                        </div>
                        <div class="totp-step">
                            <span class="step-number">3</span>
                            <span>${_('settings.totp_step3')}</span>
                        </div>
                    </div>
                    
                    <div class="totp-qr-container">
                        <img src="${data.qrCode}" alt="QR Code" class="totp-qr-image">
                    </div>
                    
                    <div class="totp-manual-key">
                        <p class="totp-manual-label">${_('settings.totp_manual_key')}:</p>
                        <code class="totp-secret-code">${data.secret}</code>
                        <button class="btn btn-sm btn-ghost" onclick="navigator.clipboard.writeText('${data.secret}')">
                            <span class="material-icons" style="font-size: 16px;">content_copy</span>
                        </button>
                    </div>
                    
                    <div class="totp-verify-form">
                        <label class="form-label">${_('settings.totp_enter_code')}:</label>
                        <div class="totp-verify-input-group">
                            <input type="text" id="totp-setup-code" class="form-input totp-input" 
                                   placeholder="000000" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autofocus>
                            <button class="btn btn-primary" id="totp-verify-btn">
                                <span class="material-icons">check</span>
                                ${_('settings.totp_verify_enable')}
                            </button>
                        </div>
                    </div>
                    
                    <button class="btn btn-ghost totp-cancel-btn" id="totp-cancel-btn">
                        ${_('actions.cancel')}
                    </button>
                </div>
            `;
            
            // Handle verify
            document.getElementById('totp-verify-btn')?.addEventListener('click', async () => {
                const code = document.getElementById('totp-setup-code').value.trim();
                if (!code || code.length !== 6) {
                    Notifications.error(_('auth.totp_enter_code'));
                    return;
                }
                
                try {
                    const result = await Utils.api('/api/auth/totp/enable', {
                        method: 'POST',
                        body: { code }
                    });
                    
                    // Show recovery codes
                    showRecoveryCodes(container, result.recoveryCodes);
                    
                } catch (err) {
                    Notifications.error(err.message || _('auth.totp_invalid_code'));
                }
            });
            
            // Auto-submit on 6 digits
            document.getElementById('totp-setup-code')?.addEventListener('input', (e) => {
                e.target.value = e.target.value.replace(/[^0-9]/g, '');
            });
            
            // Cancel
            document.getElementById('totp-cancel-btn')?.addEventListener('click', () => {
                initTotpSection();
            });
            
        } catch (error) {
            Notifications.error(error.message || _('errors.server_error'));
        }
    }
    
    /**
     * Show recovery codes after enabling TOTP
     */
    function showRecoveryCodes(container, codes) {
        container.innerHTML = `
            <div class="totp-recovery">
                <div class="totp-success-header">
                    <span class="material-icons totp-success-icon">verified_user</span>
                    <h3>${_('settings.totp_enabled_success')}</h3>
                </div>
                
                <div class="totp-recovery-warning">
                    <span class="material-icons">warning</span>
                    <p>${_('settings.totp_recovery_warning')}</p>
                </div>
                
                <div class="totp-recovery-codes">
                    ${codes.map(code => `<code class="recovery-code">${code}</code>`).join('')}
                </div>
                
                <div class="totp-recovery-actions">
                    <button class="btn btn-secondary" id="copy-recovery-btn">
                        <span class="material-icons">content_copy</span>
                        ${_('actions.copy')}
                    </button>
                </div>
                
                <button class="btn btn-primary totp-done-btn" id="totp-done-btn">
                    <span class="material-icons">check</span>
                    ${_('settings.totp_done')}
                </button>
            </div>
        `;
        
        document.getElementById('copy-recovery-btn')?.addEventListener('click', () => {
            navigator.clipboard.writeText(codes.join('\n'));
            Notifications.success(_('common.copied'));
        });
        
        document.getElementById('totp-done-btn')?.addEventListener('click', () => {
            initTotpSection();
        });
        
        Notifications.success(_('settings.totp_enabled_success'));
    }
    
    /**
     * Handle TOTP disable
     */
    async function handleDisableTotp() {
        const container = document.getElementById('totp-status-container');
        
        container.innerHTML = `
            <div class="totp-disable-confirm">
                <div class="totp-disable-warning">
                    <span class="material-icons">warning</span>
                    <p>${_('settings.totp_disable_warning')}</p>
                </div>
                <div class="form-group">
                    <label class="form-label">${_('settings.current_password')}:</label>
                    <input type="password" id="totp-disable-password" class="form-input" 
                           placeholder="${_('auth.password_placeholder')}" required>
                </div>
                <div class="totp-disable-actions">
                    <button class="btn btn-danger" id="confirm-disable-btn">
                        <span class="material-icons">lock_open</span>
                        ${_('settings.totp_disable')}
                    </button>
                    <button class="btn btn-ghost" id="cancel-disable-btn">
                        ${_('actions.cancel')}
                    </button>
                </div>
            </div>
        `;
        
        document.getElementById('confirm-disable-btn')?.addEventListener('click', async () => {
            const password = document.getElementById('totp-disable-password').value;
            if (!password) {
                Notifications.error(_('auth.fill_all_fields'));
                return;
            }
            
            try {
                await Utils.api('/api/auth/totp/disable', {
                    method: 'POST',
                    body: { password }
                });
                
                Notifications.success(_('settings.totp_disabled_success'));
                initTotpSection();
                
            } catch (err) {
                Notifications.error(err.message || _('errors.server_error'));
            }
        });
        
        document.getElementById('cancel-disable-btn')?.addEventListener('click', () => {
            initTotpSection();
        });
    }
    
    // ==================== Branding / Theming Section ====================
    
    let brandingData = null;
    
    /**
     * Initialize branding configuration section
     */
    async function initBrandingSection() {
        try {
            const response = await Utils.api('/api/settings/branding');
            brandingData = response.data || response;
            
            populateBrandingForm(brandingData);
            initLogoTypeSelector();
            initColorPickers();
            initBrandingActions();
            
        } catch (error) {
            console.error('Failed to load branding:', error);
        }
    }
    
    /**
     * Populate branding form with current config
     */
    function populateBrandingForm(data) {
        // Identity fields
        const nameInput = document.getElementById('brand-name');
        const descInput = document.getElementById('brand-description');
        if (nameInput) nameInput.value = data.appName || '';
        if (descInput) descInput.value = data.appDescription || '';
        
        // Logo type
        const logoTypeRadio = document.querySelector(`input[name="logo-type"][value="${data.logoType || 'icon'}"]`);
        if (logoTypeRadio) {
            logoTypeRadio.checked = true;
            showLogoPanel(data.logoType || 'icon');
        }
        
        // Logo fields
        const iconInput = document.getElementById('logo-icon-name');
        const svgInput = document.getElementById('logo-svg-input');
        const imageInput = document.getElementById('logo-image-url');
        if (iconInput) iconInput.value = data.logoIcon || 'dns';
        if (svgInput) svgInput.value = data.logoSvg || '';
        if (imageInput) imageInput.value = data.logoUrl || '';
        
        // Colors
        if (data.colors) {
            for (const [key, value] of Object.entries(data.colors)) {
                if (!value) continue;
                const picker = document.querySelector(`.color-picker[data-color="${key}"]`);
                const hex = document.querySelector(`.color-hex[data-color="${key}"]`);
                if (picker) picker.value = value;
                if (hex) hex.value = value;
            }
        }
        
        // Update preview
        updateLogoPreview();
    }
    
    /**
     * Initialize logo type selector
     */
    function initLogoTypeSelector() {
        const radios = document.querySelectorAll('input[name="logo-type"]');
        radios.forEach(radio => {
            radio.addEventListener('change', () => {
                showLogoPanel(radio.value);
                updateLogoPreview();
            });
        });
        
        // Live preview on input changes
        document.getElementById('logo-icon-name')?.addEventListener('input', updateLogoPreview);
        document.getElementById('logo-svg-input')?.addEventListener('input', updateLogoPreview);
        document.getElementById('logo-image-url')?.addEventListener('input', updateLogoPreview);
        document.getElementById('brand-name')?.addEventListener('input', updateLogoPreview);
        
        // File upload handler
        document.getElementById('logo-image-file')?.addEventListener('change', handleLogoFileUpload);
    }
    
    /**
     * Show the correct logo config panel
     */
    function showLogoPanel(type) {
        document.querySelectorAll('.logo-config-panel').forEach(p => p.classList.add('hidden'));
        const panel = document.getElementById(`logo-${type}-panel`);
        if (panel) panel.classList.remove('hidden');
    }
    
    /**
     * Sanitize SVG content to prevent XSS attacks.
     * Removes potentially dangerous elements and attributes.
     * @param {string} svg - Raw SVG string
     * @returns {string} - Sanitized SVG string
     */
    function sanitizeSvg(svg) {
        // Parse the SVG
        const parser = new DOMParser();
        const doc = parser.parseFromString(svg, 'image/svg+xml');
        
        // Check for parsing errors
        const parserError = doc.querySelector('parsererror');
        if (parserError) return '<!-- Invalid SVG -->';
        
        const svgEl = doc.querySelector('svg');
        if (!svgEl) return '<!-- No SVG element found -->';
        
        // Remove dangerous elements
        const dangerousTags = ['script', 'foreignobject', 'iframe', 'embed', 'object', 'applet'];
        dangerousTags.forEach(tag => {
            doc.querySelectorAll(tag).forEach(el => el.remove());
        });
        
        // Remove dangerous attributes from all elements
        const dangerousAttrs = [
            'onclick', 'ondblclick', 'onmousedown', 'onmouseup', 'onmouseover', 'onmousemove',
            'onmouseout', 'onmouseenter', 'onmouseleave', 'onkeydown', 'onkeypress', 'onkeyup',
            'onload', 'onerror', 'onabort', 'onfocus', 'onblur', 'onchange', 'onsubmit', 'onreset',
            'onselect', 'onunload', 'xlink:href'
        ];
        
        doc.querySelectorAll('*').forEach(el => {
            dangerousAttrs.forEach(attr => el.removeAttribute(attr));
            // Remove href pointing to javascript:
            if (el.hasAttribute('href') && el.getAttribute('href').toLowerCase().trim().startsWith('javascript:')) {
                el.removeAttribute('href');
            }
        });
        
        return svgEl.outerHTML;
    }
    
    /**
     * Update logo preview
     */
    function updateLogoPreview() {
        const preview = document.getElementById('logo-preview');
        if (!preview) return;
        
        const type = document.querySelector('input[name="logo-type"]:checked')?.value || 'icon';
        const name = document.getElementById('brand-name')?.value || 'BetterDesk';
        
        if (type === 'svg') {
            const svg = document.getElementById('logo-svg-input')?.value || '';
            if (svg.trim()) {
                preview.innerHTML = `<span class="logo-preview-svg">${sanitizeSvg(svg)}</span>`;
            } else {
                preview.innerHTML = `<span class="material-icons">code</span><span class="logo-preview-text">${Utils.escapeHtml(name)}</span>`;
            }
        } else if (type === 'image') {
            const url = document.getElementById('logo-image-url')?.value || '';
            if (url.trim()) {
                preview.innerHTML = `<img src="${Utils.escapeHtml(url)}" alt="${Utils.escapeHtml(name)}" style="max-height: 36px;">`;
            } else {
                preview.innerHTML = `<span class="material-icons">photo</span><span class="logo-preview-text">${Utils.escapeHtml(name)}</span>`;
            }
        } else {
            const icon = document.getElementById('logo-icon-name')?.value || 'dns';
            preview.innerHTML = `<span class="material-icons">${Utils.escapeHtml(icon)}</span><span class="logo-preview-text">${Utils.escapeHtml(name)}</span>`;
        }
    }
    
    /**
     * Handle logo image file upload - convert to base64 data URI
     */
    function handleLogoFileUpload(e) {
        const file = e.target.files[0];
        if (!file) return;
        
        const maxSize = 1.5 * 1024 * 1024; // 1.5MB
        if (file.size > maxSize) {
            Utils.showNotification(_('branding.logo_image_too_large'), 'error');
            e.target.value = '';
            return;
        }
        
        const validTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];
        if (!validTypes.includes(file.type)) {
            Utils.showNotification(_('branding.logo_image_invalid_type'), 'error');
            e.target.value = '';
            return;
        }
        
        // Show filename
        const nameEl = document.getElementById('logo-file-name');
        if (nameEl) nameEl.textContent = file.name;
        
        const reader = new FileReader();
        reader.onload = function(event) {
            const dataUri = event.target.result;
            const urlInput = document.getElementById('logo-image-url');
            if (urlInput) {
                urlInput.value = dataUri;
                urlInput.removeAttribute('readonly');
            }
            updateLogoPreview();
        };
        reader.readAsDataURL(file);
    }
    
    /**
     * Initialize color picker sync (picker <-> hex input)
     */
    function initColorPickers() {
        // Sync color picker → hex input
        document.querySelectorAll('.color-picker').forEach(picker => {
            picker.addEventListener('input', () => {
                const key = picker.dataset.color;
                const hex = document.querySelector(`.color-hex[data-color="${key}"]`);
                if (hex) hex.value = picker.value;
            });
        });
        
        // Sync hex input → color picker
        document.querySelectorAll('.color-hex').forEach(hex => {
            hex.addEventListener('input', () => {
                const key = hex.dataset.color;
                const picker = document.querySelector(`.color-picker[data-color="${key}"]`);
                if (picker && /^#[0-9a-fA-F]{6}$/.test(hex.value)) {
                    picker.value = hex.value;
                }
            });
        });
    }
    
    /**
     * Collect branding form data
     */
    function collectBrandingData() {
        const data = {
            appName: document.getElementById('brand-name')?.value || 'BetterDesk',
            appDescription: document.getElementById('brand-description')?.value || '',
            logoType: document.querySelector('input[name="logo-type"]:checked')?.value || 'icon',
            logoIcon: document.getElementById('logo-icon-name')?.value || 'dns',
            logoSvg: document.getElementById('logo-svg-input')?.value || '',
            logoUrl: document.getElementById('logo-image-url')?.value || '',
            colors: {}
        };
        
        // Collect colors
        document.querySelectorAll('.color-hex').forEach(hex => {
            const key = hex.dataset.color;
            const value = hex.value.trim();
            if (value && /^#[0-9a-fA-F]{6}$/.test(value)) {
                data.colors[key] = value;
            }
        });
        
        return data;
    }
    
    /**
     * Initialize branding action buttons
     */
    function initBrandingActions() {
        // Save
        document.getElementById('branding-save-btn')?.addEventListener('click', async () => {
            try {
                const data = collectBrandingData();
                await Utils.api('/api/settings/branding', {
                    method: 'POST',
                    body: data
                });
                Notifications.success(_('branding.saved'));
                
                // Reload page to apply changes
                setTimeout(() => window.location.reload(), 800);
                
            } catch (error) {
                Notifications.error(error.message || _('errors.server_error'));
            }
        });
        
        // Export
        document.getElementById('branding-export-btn')?.addEventListener('click', async () => {
            try {
                const response = await Utils.api('/api/settings/branding/export');
                const blob = new Blob([JSON.stringify(response, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'betterdesk-theme.json';
                a.click();
                URL.revokeObjectURL(url);
                Notifications.success(_('branding.exported'));
            } catch (error) {
                Notifications.error(error.message || _('errors.server_error'));
            }
        });
        
        // Import
        document.getElementById('branding-import-input')?.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            try {
                const text = await file.text();
                const preset = JSON.parse(text);
                
                await Utils.api('/api/settings/branding/import', {
                    method: 'POST',
                    body: preset
                });
                
                Notifications.success(_('branding.imported'));
                setTimeout(() => window.location.reload(), 800);
                
            } catch (error) {
                Notifications.error(error.message || _('branding.import_error'));
            }
            
            // Reset file input
            e.target.value = '';
        });
        
        // Reset
        document.getElementById('branding-reset-btn')?.addEventListener('click', async () => {
            if (!confirm(_('branding.reset_confirm'))) return;
            
            try {
                await Utils.api('/api/settings/branding/reset', { method: 'POST' });
                Notifications.success(_('branding.reset_success'));
                setTimeout(() => window.location.reload(), 800);
            } catch (error) {
                Notifications.error(error.message || _('errors.server_error'));
            }
        });
    }
    
    // ==================== Server Backend Selection ====================
    
    let _currentBackend = null;
    
    function initBackendSection() {
        const radios = document.querySelectorAll('input[name="server-backend"]');
        const testBtn = document.getElementById('backend-test-btn');
        const saveBtn = document.getElementById('backend-save-btn');
        
        if (!radios.length) return;
        
        // Load current backend
        loadBackendStatus();
        
        // Radio change — enable save button when different from current
        radios.forEach(radio => {
            radio.addEventListener('change', () => {
                const selected = document.querySelector('input[name="server-backend"]:checked')?.value;
                saveBtn.disabled = (selected === _currentBackend);
            });
        });
        
        // Test connection button
        testBtn?.addEventListener('click', async () => {
            const selected = document.querySelector('input[name="server-backend"]:checked')?.value;
            if (!selected) return;
            
            testBtn.disabled = true;
            testBtn.innerHTML = '<span class="material-icons spin">sync</span> ' + _('settings.backend_testing');
            
            try {
                const result = await Utils.api('/api/settings/backend/test', {
                    method: 'POST',
                    body: { backend: selected }
                });
                
                const health = result.health || {};
                updateBackendHealth(health);
                
                if (health.status === 'running') {
                    Notifications.success(_('settings.backend_test_success'));
                } else {
                    Notifications.warning(_('settings.backend_test_failed'));
                }
            } catch (error) {
                Notifications.error(error.message || _('settings.backend_test_failed'));
                updateBackendHealth({ status: 'error' });
            } finally {
                testBtn.disabled = false;
                testBtn.innerHTML = '<span class="material-icons">wifi_tethering</span> ' + _('settings.backend_test');
            }
        });
        
        // Save button
        saveBtn?.addEventListener('click', async () => {
            const selected = document.querySelector('input[name="server-backend"]:checked')?.value;
            if (!selected || selected === _currentBackend) return;
            
            if (!confirm(_('settings.backend_confirm_switch'))) return;
            
            saveBtn.disabled = true;
            
            try {
                const result = await Utils.api('/api/settings/backend', {
                    method: 'POST',
                    body: { backend: selected }
                });
                
                _currentBackend = selected;
                highlightActiveBackend(selected);
                updateBackendHealth(result.health || {});
                Notifications.success(_('settings.backend_saved'));
                saveBtn.disabled = true;
                
            } catch (error) {
                Notifications.error(error.message || _('settings.backend_save_failed'));
                saveBtn.disabled = false;
            }
        });
    }
    
    async function loadBackendStatus() {
        try {
            const result = await Utils.api('/api/settings/backend');
            _currentBackend = result.backend || 'rustdesk';
            
            // Select the radio
            const radio = document.querySelector(`input[name="server-backend"][value="${_currentBackend}"]`);
            if (radio) radio.checked = true;
            
            highlightActiveBackend(_currentBackend);
            updateBackendHealth(result.health || {});
            
        } catch (error) {
            console.error('Failed to load backend status:', error);
        }
    }
    
    function highlightActiveBackend(name) {
        document.querySelectorAll('.backend-option').forEach(opt => {
            opt.classList.remove('active');
        });
        const activeOpt = document.getElementById('backend-opt-' + name);
        if (activeOpt) activeOpt.classList.add('active');
    }
    
    function updateBackendHealth(health) {
        const el = document.getElementById('backend-health-status');
        if (!el) return;
        
        const status = health.status || 'unknown';
        el.className = 'backend-health backend-health-' + status;
        
        const labels = {
            'running': _('settings.backend_status_running'),
            'unreachable': _('settings.backend_status_unreachable'),
            'error': _('settings.backend_status_error'),
            'unknown': _('settings.backend_status_unknown')
        };
        el.textContent = labels[status] || status;
        
        // Update API URL display
        const urlEl = document.getElementById('backend-api-url');
        if (urlEl) {
            const selected = document.querySelector('input[name="server-backend"]:checked')?.value;
            urlEl.textContent = health.backend === 'betterdesk' || selected === 'betterdesk'
                ? (health.api_url || 'BetterDesk Go API')
                : 'HBBS REST API';
        }
    }
    
    // ==================== Backup & Restore ====================
    
    function initBackupSection() {
        loadBackupStats();
        
        // Download backup
        document.getElementById('backup-download-btn')?.addEventListener('click', async () => {
            const btn = document.getElementById('backup-download-btn');
            if (!btn) return;
            btn.disabled = true;
            btn.innerHTML = '<span class="material-icons spinning">sync</span> ' + _('backup.creating');
            
            try {
                const fetchHeaders = {};
                if (window.BetterDesk && window.BetterDesk.csrfToken) {
                    fetchHeaders['X-CSRF-Token'] = window.BetterDesk.csrfToken;
                }
                const response = await fetch('/api/settings/backup', {
                    credentials: 'same-origin',
                    headers: fetchHeaders
                });
                if (!response.ok) throw new Error('Backup failed');
                
                const blob = await response.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                const date = new Date().toISOString().slice(0, 10);
                a.download = `betterdesk-backup-${date}.json`;
                a.click();
                URL.revokeObjectURL(url);
                
                Notifications.success(_('backup.download_success'));
            } catch (error) {
                Notifications.error(error.message || _('errors.server_error'));
            } finally {
                btn.disabled = false;
                btn.innerHTML = '<span class="material-icons">download</span> ' + _('backup.download');
            }
        });
        
        // Restore from file
        document.getElementById('restore-file-input')?.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            if (!file.name.endsWith('.json')) {
                Notifications.error(_('backup.invalid_json'));
                e.target.value = '';
                return;
            }
            
            if (!confirm(_('backup.restore_confirm'))) {
                e.target.value = '';
                return;
            }
            
            const resultEl = document.getElementById('restore-result');
            const label = document.getElementById('restore-upload-label');
            
            try {
                // Read and validate client-side first
                const text = await file.text();
                let data;
                try {
                    data = JSON.parse(text);
                } catch {
                    Notifications.error(_('backup.invalid_json'));
                    e.target.value = '';
                    return;
                }
                
                if (data._format !== 'betterdesk-backup') {
                    Notifications.error(_('backup.invalid_format'));
                    e.target.value = '';
                    return;
                }
                
                // Build FormData with options
                const formData = new FormData();
                formData.append('backup', file);
                formData.append('restoreSettings', document.getElementById('restore-settings')?.checked ?? true);
                formData.append('restoreBranding', document.getElementById('restore-branding')?.checked ?? true);
                formData.append('restoreUsers', document.getElementById('restore-users')?.checked ?? false);
                formData.append('restoreFolders', document.getElementById('restore-folders')?.checked ?? true);
                formData.append('restoreGroups', document.getElementById('restore-groups')?.checked ?? true);
                formData.append('restoreAddressBooks', document.getElementById('restore-addressbooks')?.checked ?? true);
                
                if (label) label.classList.add('loading');
                
                const headers = {};
                if (window.BetterDesk && window.BetterDesk.csrfToken) {
                    headers['X-CSRF-Token'] = window.BetterDesk.csrfToken;
                }
                
                const response = await fetch('/api/settings/restore', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: headers,
                    body: formData
                });
                
                const result = await response.json();
                
                if (result.success) {
                    Notifications.success(_('backup.restore_success'));
                    showRestoreResult(result.data, resultEl);
                } else {
                    Notifications.error(result.error || _('errors.server_error'));
                }
            } catch (error) {
                Notifications.error(error.message || _('errors.server_error'));
            } finally {
                e.target.value = '';
                if (label) label.classList.remove('loading');
            }
        });
    }
    
    async function loadBackupStats() {
        try {
            const data = await Utils.api('/api/settings/backup/stats');
            if (!data) return;
            
            const setVal = (id, val) => {
                const el = document.getElementById(id);
                if (el) el.textContent = val;
            };
            
            setVal('backup-stat-users', data.users || 0);
            setVal('backup-stat-settings', data.settings || 0);
            setVal('backup-stat-folders', data.folders || 0);
            setVal('backup-stat-groups', (data.userGroups || 0) + (data.deviceGroups || 0));
            setVal('backup-stat-strategies', data.strategies || 0);
            setVal('backup-stat-backend', data.backend === 'betterdesk' ? 'BetterDesk Go' : 'RustDesk');
        } catch { /* silent */ }
    }
    
    function showRestoreResult(data, el) {
        if (!el) return;
        el.style.display = 'block';
        
        let html = '<div class="restore-result-inner">';
        if (data.restored.length) {
            html += `<p class="restore-ok"><span class="material-icons">check_circle</span> ${_('backup.restored')}: <strong>${Utils.escapeHtml(data.restored.join(', '))}</strong></p>`;
        }
        if (data.skipped.length) {
            html += `<p class="restore-skip"><span class="material-icons">skip_next</span> ${_('backup.skipped')}: ${Utils.escapeHtml(data.skipped.join(', '))}</p>`;
        }
        if (data.warnings && data.warnings.length) {
            html += `<p class="restore-warn"><span class="material-icons">warning</span> ${data.warnings.map(w => Utils.escapeHtml(w)).join('<br>')}</p>`;
        }
        if (data.backupDate) {
            html += `<p class="restore-meta">${_('backup.backup_date')}: ${Utils.escapeHtml(data.backupDate)}</p>`;
        }
        html += '</div>';
        el.innerHTML = html;
    }
    
})();
