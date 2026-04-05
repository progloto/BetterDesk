/**
 * BetterDesk Console — Organization Detail Page JavaScript
 *
 * Handles org detail view with tabs: Users, Devices, Invitations, Settings.
 */
'use strict';

(function () {
    const orgId = document.querySelector('.org-detail-page')?.dataset.orgId;
    if (!orgId) return;

    const API = `/api/panel/org/${orgId}`;

    // -----------------------------------------------------------------------
    //  Helpers
    // -----------------------------------------------------------------------
    async function api(method, path, body) {
        const csrfToken = window.BetterDesk?.csrfToken || '';
        const opts = {
            method,
            headers: { 'Content-Type': 'application/json' },
        };
        if (csrfToken) opts.headers['x-csrf-token'] = csrfToken;
        if (body) opts.body = JSON.stringify(body);
        const res = await fetch(API + path, opts);
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || 'Request failed');
        }
        if (res.status === 204) return null;
        return res.json();
    }

    function toast(msg, type = 'info') {
        if (window.showToast) window.showToast(msg, type);
        else console.log(`[${type}]`, msg);
    }

    function escHtml(s) {
        const d = document.createElement('div');
        d.textContent = s || '';
        return d.innerHTML;
    }

    function formatDate(d) {
        if (!d) return '—';
        return new Date(d).toLocaleDateString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
    }

    // -----------------------------------------------------------------------
    //  Tabs
    // -----------------------------------------------------------------------
    document.querySelectorAll('.org-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.org-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.org-tab-content').forEach(c => c.style.display = 'none');
            tab.classList.add('active');
            document.getElementById(`tab-${tab.dataset.tab}`).style.display = 'block';
        });
    });

    // -----------------------------------------------------------------------
    //  Load org header
    // -----------------------------------------------------------------------
    async function loadOrgHeader() {
        try {
            const org = await api('GET', '');
            document.getElementById('org-detail-name').textContent = org.name;
            document.getElementById('org-detail-slug').textContent = org.slug;
        } catch (err) {
            toast('Failed to load organization', 'error');
        }
    }

    // -----------------------------------------------------------------------
    //  Users tab
    // -----------------------------------------------------------------------
    async function loadUsers() {
        try {
            const data = await api('GET', '/users');
            const users = data.users || [];
            document.getElementById('users-count').textContent = users.length;
            const container = document.getElementById('users-table');

            if (users.length === 0) {
                container.innerHTML = '<p class="text-muted">No users in this organization.</p>';
                return;
            }

            container.innerHTML = `
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Username</th>
                            <th>Display Name</th>
                            <th>Email</th>
                            <th>Role</th>
                            <th>Last Login</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${users.map(u => `
                            <tr>
                                <td><strong>${escHtml(u.username)}</strong></td>
                                <td>${escHtml(u.display_name)}</td>
                                <td>${escHtml(u.email)}</td>
                                <td><span class="role-badge role-${u.role}">${u.role}</span></td>
                                <td>${formatDate(u.last_login)}</td>
                                <td>
                                    <button class="btn btn-icon btn-sm user-remove-btn" data-user-id="${u.id}" title="Remove">
                                        <span class="material-icons">person_remove</span>
                                    </button>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>`;

            container.querySelectorAll('.user-remove-btn').forEach(btn => {
                btn.addEventListener('click', () => deleteUser(btn.dataset.userId));
            });
        } catch (err) {
            toast('Failed to load users', 'error');
        }
    }

    document.getElementById('add-user-btn')?.addEventListener('click', async () => {
        const username = prompt('Username:');
        if (!username) return;
        const password = prompt('Password:');
        if (!password) return;
        const role = prompt('Role (owner/admin/operator/user):', 'user');
        try {
            await api('POST', '/users', { username, password, role: role || 'user' });
            toast('User added', 'success');
            loadUsers();
        } catch (err) {
            toast(err.message, 'error');
        }
    });

    // -----------------------------------------------------------------------
    //  Devices tab
    // -----------------------------------------------------------------------
    async function loadDevices() {
        try {
            const data = await api('GET', '/devices');
            const devices = data.devices || [];
            document.getElementById('devices-count').textContent = devices.length;
            const container = document.getElementById('devices-table');

            if (devices.length === 0) {
                container.innerHTML = '<p class="text-muted">No devices assigned to this organization.</p>';
                return;
            }

            container.innerHTML = `
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Device ID</th>
                            <th>Department</th>
                            <th>Building</th>
                            <th>Location</th>
                            <th>Assigned User</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${devices.map(d => `
                            <tr>
                                <td><a href="/devices/${d.device_id}">${escHtml(d.device_id)}</a></td>
                                <td>${escHtml(d.department)}</td>
                                <td>${escHtml(d.building)}</td>
                                <td>${escHtml(d.location)}</td>
                                <td>${escHtml(d.assigned_user_id)}</td>
                                <td>
                                    <button class="btn btn-icon btn-sm btn-danger device-unassign-btn" data-device-id="${d.device_id}" title="Unassign">
                                        <span class="material-icons">link_off</span>
                                    </button>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>`;

            container.querySelectorAll('.device-unassign-btn').forEach(btn => {
                btn.addEventListener('click', () => unassignDevice(btn.dataset.deviceId));
            });
        } catch (err) {
            toast('Failed to load devices', 'error');
        }
    }

    document.getElementById('assign-device-btn')?.addEventListener('click', async () => {
        const deviceId = prompt('Device ID to assign:');
        if (!deviceId) return;
        const dept = prompt('Department (optional):') || '';
        const building = prompt('Building (optional):') || '';
        try {
            await api('POST', '/devices', { device_id: deviceId, department: dept, building });
            toast('Device assigned', 'success');
            loadDevices();
        } catch (err) {
            toast(err.message, 'error');
        }
    });

    // -----------------------------------------------------------------------
    //  Invitations tab
    // -----------------------------------------------------------------------
    async function loadInvitations() {
        try {
            const data = await api('GET', '/invitations');
            const invs = data.invitations || [];
            document.getElementById('invitations-count').textContent = invs.length;
            const container = document.getElementById('invitations-table');

            if (invs.length === 0) {
                container.innerHTML = '<p class="text-muted">No invitations.</p>';
                return;
            }

            container.innerHTML = `
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Token</th>
                            <th>Email</th>
                            <th>Role</th>
                            <th>Expires</th>
                            <th>Used</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${invs.map(inv => `
                            <tr>
                                <td><code>${escHtml(inv.token?.substring(0, 16) + '...')}</code></td>
                                <td>${escHtml(inv.email)}</td>
                                <td><span class="role-badge role-${inv.role}">${inv.role}</span></td>
                                <td>${formatDate(inv.expires_at)}</td>
                                <td>${inv.used_at ? formatDate(inv.used_at) : '—'}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>`;
        } catch (err) {
            toast('Failed to load invitations', 'error');
        }
    }

    document.getElementById('create-invite-btn')?.addEventListener('click', async () => {
        const email = prompt('Email (optional):') || '';
        const role = prompt('Role (user/operator/admin):', 'user') || 'user';
        try {
            const inv = await api('POST', '/invite', { email, role, expires_in_hours: 72 });
            toast('Invitation created! Token: ' + (inv.token || '').substring(0, 16) + '...', 'success');
            loadInvitations();
        } catch (err) {
            toast(err.message, 'error');
        }
    });

    // -----------------------------------------------------------------------
    //  Settings tab
    // -----------------------------------------------------------------------
    async function loadSettings() {
        try {
            const data = await api('GET', '/settings');
            const settings = data.settings || [];
            const container = document.getElementById('settings-container');

            container.innerHTML = `
                <div class="org-settings-form">
                    <div class="form-group">
                        <label>Connection Policy</label>
                        <select id="setting-connection-policy" class="form-input">
                            <option value="unattended">Unattended (instant)</option>
                            <option value="attended">Attended (with confirmation)</option>
                            <option value="ask_always">Always ask</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Allow File Transfer</label>
                        <select id="setting-allow-file-transfer" class="form-input">
                            <option value="true">Yes</option>
                            <option value="false">No</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Allow Clipboard</label>
                        <select id="setting-allow-clipboard" class="form-input">
                            <option value="true">Yes</option>
                            <option value="false">No</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Max Session Duration (minutes)</label>
                        <input type="number" id="setting-max-session" class="form-input" value="120" min="0" />
                    </div>
                    <button class="btn btn-primary" id="save-settings-btn">Save Settings</button>
                </div>
                <div class="org-settings-raw">
                    <h3>Raw Settings</h3>
                    <table class="data-table">
                        <thead><tr><th>Key</th><th>Value</th></tr></thead>
                        <tbody>
                            ${settings.map(s => `
                                <tr><td><code>${escHtml(s.key)}</code></td><td>${escHtml(s.value)}</td></tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>`;

            // Apply current settings to form
            settings.forEach(s => {
                const el = document.getElementById(`setting-${s.key.replace(/_/g, '-')}`);
                if (el) el.value = s.value;
            });

            document.getElementById('save-settings-btn')?.addEventListener('click', async () => {
                const settingsToSave = [
                    { key: 'connection_policy', value: document.getElementById('setting-connection-policy')?.value || 'unattended' },
                    { key: 'allow_file_transfer', value: document.getElementById('setting-allow-file-transfer')?.value || 'true' },
                    { key: 'allow_clipboard', value: document.getElementById('setting-allow-clipboard')?.value || 'true' },
                    { key: 'max_session_duration_min', value: document.getElementById('setting-max-session')?.value || '120' },
                ];
                try {
                    for (const s of settingsToSave) {
                        await api('PUT', '/settings', s);
                    }
                    toast('Settings saved', 'success');
                    loadSettings();
                } catch (err) {
                    toast(err.message, 'error');
                }
            });
        } catch (err) {
            toast('Failed to load settings', 'error');
        }
    }

    // -----------------------------------------------------------------------
    //  Delete org
    // -----------------------------------------------------------------------
    document.getElementById('org-delete-btn')?.addEventListener('click', async () => {
        if (!confirm('Delete this organization and all associated data?')) return;
        try {
            await api('DELETE', '');
            toast('Organization deleted', 'success');
            window.location.href = '/organizations';
        } catch (err) {
            toast(err.message, 'error');
        }
    });

    async function deleteUser(uid) {
        if (!confirm('Remove this user from the organization?')) return;
        try {
            await api('DELETE', `/users/${uid}`);
            toast('User removed', 'success');
            loadUsers();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    async function unassignDevice(did) {
        if (!confirm('Unassign this device from the organization?')) return;
        try {
            await api('DELETE', `/devices/${did}`);
            toast('Device unassigned', 'success');
            loadDevices();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    // -----------------------------------------------------------------------
    //  Init
    // -----------------------------------------------------------------------
    loadOrgHeader();
    loadUsers();
    loadDevices();
    loadInvitations();
    loadSettings();

})();
