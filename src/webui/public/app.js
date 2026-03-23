/* =============================================
   SMTP2Graph WebUI — Frontend Logic
   ============================================= */

(function() {
    'use strict';

    // State
    let currentTab = 'dashboard';
    let healthPollInterval = null;
    let editingAccount = null; // null = adding new, string = editing existing

    // ---- Tab Navigation ----
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            switchTab(tab.dataset.tab);
        });
    });

    function switchTab(tabName) {
        currentTab = tabName;
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
        document.querySelector('.tab[data-tab="' + tabName + '"]').classList.add('active');
        document.getElementById('tab-' + tabName).classList.remove('hidden');

        if(tabName === 'dashboard') startHealthPolling();
        else stopHealthPolling();

        if(tabName === 'accounts') loadAccounts();
        if(tabName === 'config') loadConfig();
    }

    // ---- Fetch helpers ----
    function apiFetch(url, options) {
        options = options || {};
        options.headers = Object.assign({}, options.headers, {
            'X-Requested-With': 'XMLHttpRequest',
        });
        if(options.body && !options.headers['Content-Type'])
            options.headers['Content-Type'] = 'application/json';
        return fetch(url, options);
    }

    // ---- Dashboard ----
    function startHealthPolling() {
        fetchHealth();
        fetchLogs();
        healthPollInterval = setInterval(() => {
            fetchHealth();
            fetchLogs();
        }, 10000);
    }

    function stopHealthPolling() {
        if(healthPollInterval) {
            clearInterval(healthPollInterval);
            healthPollInterval = null;
        }
    }

    async function fetchHealth() {
        try {
            const res = await fetch('/api/health');
            const data = await res.json();
            updateDashboard(data);
            setStatus('Health data refreshed');
        } catch(err) {
            setStatus('Failed to fetch health data');
        }
    }

    function el(tag, className, text) {
        const e = document.createElement(tag);
        if(className) e.className = className;
        if(text !== undefined) e.textContent = text;
        return e;
    }

    function updateDashboard(data) {
        // SMTP Status
        const smtpIcon = document.getElementById('smtp-icon');
        const smtpText = document.getElementById('smtp-status-text');
        if(data.smtp.listening) {
            smtpIcon.className = 'status-icon ok';
            smtpText.textContent = 'Running';
        } else {
            smtpIcon.className = 'status-icon error';
            smtpText.textContent = 'Stopped';
        }
        document.getElementById('smtp-port').textContent = data.smtp.port;
        document.getElementById('smtp-mode').textContent = data.smtp.mode;
        document.getElementById('smtp-uptime').textContent = formatUptime(data.uptime);
        document.getElementById('smtp-version').textContent = 'v' + data.version;

        // Queue
        document.getElementById('queue-queued').textContent = data.queue.queued;
        document.getElementById('queue-retrying').textContent = data.queue.retrying;
        document.getElementById('queue-failed').textContent = data.queue.failed;
        document.getElementById('queue-temp').textContent = data.queue.temp;

        // Account Health Cards
        const container = document.getElementById('account-cards');
        while(container.firstChild) container.removeChild(container.firstChild);

        if(data.accounts.length === 0) {
            container.appendChild(el('p', 'placeholder', 'No accounts configured'));
            return;
        }

        data.accounts.forEach(acct => {
            const card = el('div', 'account-card');
            card.appendChild(el('div', 'card-title', acct.name));

            const body = el('div', 'card-body');

            const tenantRow = el('div', 'detail-row');
            tenantRow.appendChild(el('span', null, 'Tenant:'));
            tenantRow.appendChild(el('span', null, acct.tenant));
            body.appendChild(tenantRow);

            const apiRow = el('div', 'detail-row');
            apiRow.appendChild(el('span', null, 'Graph API:'));
            const iconClass = acct.graphApi.ok ? 'ok' : 'error';
            const statusText = acct.graphApi.ok ? 'Connected' : (acct.graphApi.error || 'Error');
            const statusSpan = el('span');
            const icon = el('span', 'status-icon ' + iconClass, '\u25CF');
            statusSpan.appendChild(icon);
            statusSpan.appendChild(document.createTextNode(' ' + statusText));
            apiRow.appendChild(statusSpan);
            body.appendChild(apiRow);

            card.appendChild(body);
            container.appendChild(card);
        });
    }

    async function fetchLogs() {
        try {
            const res = await fetch('/api/logs?lines=50');
            const entries = await res.json();
            const logContent = document.getElementById('log-content');
            logContent.textContent = entries.map(e => {
                const ts = e.timestamp || '';
                const level = (e.level || '').toUpperCase().padEnd(7);
                return '[' + ts + '] ' + level + ' ' + (e.message || JSON.stringify(e));
            }).join('\n');

            // Auto-scroll to bottom
            const logArea = document.getElementById('log-area');
            logArea.scrollTop = logArea.scrollHeight;
        } catch(err) {
            // silent
        }
    }

    // ---- Accounts Tab ----
    async function loadAccounts() {
        try {
            const res = await fetch('/api/accounts');
            const accounts = await res.json();
            renderAccountsList(accounts);
            setStatus(accounts.length + ' account(s) loaded');
        } catch(err) {
            setStatus('Failed to load accounts');
        }
    }

    function renderAccountsList(accounts) {
        const body = document.getElementById('accounts-rows');
        while(body.firstChild) body.removeChild(body.firstChild);

        if(accounts.length === 0) {
            body.appendChild(el('p', 'placeholder', 'No accounts configured. Click "Add Account" to create one.'));
            return;
        }

        accounts.forEach(acct => {
            const row = el('div', 'listview-row');
            const ipsText = acct.allowedIPs.length ? acct.allowedIPs.join(', ') : 'Any';
            const fromText = acct.allowedFrom.length ? acct.allowedFrom.join(', ') : 'Any';

            row.appendChild(el('span', 'col-name', acct.name));
            row.appendChild(el('span', 'col-tenant', acct.tenant));
            row.appendChild(el('span', 'col-auth', acct.hasCertificate ? 'Cert' : 'Secret'));

            const ipsSpan = el('span', 'col-ips', ipsText);
            ipsSpan.title = acct.allowedIPs.join(', ');
            row.appendChild(ipsSpan);

            const fromSpan = el('span', 'col-from', fromText);
            fromSpan.title = acct.allowedFrom.join(', ');
            row.appendChild(fromSpan);

            const actions = el('span', 'col-actions');
            const btnTest = el('button', 'btn btn-test', 'Test');
            btnTest.dataset.name = acct.name;
            const btnEdit = el('button', 'btn btn-edit', 'Edit');
            btnEdit.dataset.name = acct.name;
            const btnDel = el('button', 'btn btn-delete', 'Del');
            btnDel.dataset.name = acct.name;

            btnTest.addEventListener('click', (e) => { e.stopPropagation(); testAccount(acct.name); });
            btnEdit.addEventListener('click', (e) => { e.stopPropagation(); editAccount(acct.name, acct); });
            btnDel.addEventListener('click', (e) => { e.stopPropagation(); deleteAccount(acct.name); });

            actions.appendChild(btnTest);
            actions.appendChild(btnEdit);
            actions.appendChild(btnDel);
            row.appendChild(actions);

            body.appendChild(row);
        });
    }

    async function testAccount(name) {
        setStatus('Testing connectivity for "' + name + '"...');
        try {
            const res = await fetch('/api/accounts/' + encodeURIComponent(name) + '/test');
            const result = await res.json();
            if(result.ok)
                showAlert('Connection Test', 'Account "' + name + '" connected successfully!');
            else
                showAlert('Connection Test', 'Account "' + name + '" failed: ' + result.error);
        } catch(err) {
            showAlert('Error', 'Failed to test account: ' + err.message);
        }
    }

    function editAccount(name, acct) {
        editingAccount = name;
        document.getElementById('dialog-title').textContent = 'Edit Account: ' + name;
        document.getElementById('acct-name').value = acct.name;
        document.getElementById('acct-tenant').value = acct.tenant;
        document.getElementById('acct-client-id').value = acct.clientId;
        // Show masked placeholder if account has a secret — user must retype to change
        document.getElementById('acct-secret').value = acct.hasSecret ? '********' : '';
        document.getElementById('acct-cert-thumbprint').value = '';
        document.getElementById('acct-cert-key-path').value = '';
        document.getElementById('acct-allowed-ips').value = acct.allowedIPs.join('\n');
        document.getElementById('acct-allowed-from').value = acct.allowedFrom.join('\n');
        document.getElementById('acct-force-mailbox').value = acct.forceMailbox || '';
        document.getElementById('acct-retry-limit').value = acct.retryLimit;
        document.getElementById('acct-retry-interval').value = acct.retryInterval;

        document.getElementById('account-dialog-overlay').classList.remove('hidden');
    }

    async function deleteAccount(name) {
        if(!confirm('Delete account "' + name + '"? This requires a restart to take effect.')) return;
        try {
            const res = await apiFetch('/api/accounts/' + encodeURIComponent(name), {method: 'DELETE'});
            const result = await res.json();
            if(result.success) {
                showAlert('Success', result.message);
                loadAccounts();
            } else {
                showAlert('Error', (result.errors && result.errors.join('\n')) || 'Failed to delete');
            }
        } catch(err) {
            showAlert('Error', 'Failed to delete account: ' + err.message);
        }
    }

    // Add Account button
    document.getElementById('btn-add-account').addEventListener('click', () => {
        editingAccount = null;
        document.getElementById('dialog-title').textContent = 'Add Relay Account';
        document.querySelectorAll('#account-dialog .field').forEach(f => {
            if(f.tagName === 'TEXTAREA') f.value = '';
            else if(f.type === 'number') { /* keep defaults */ }
            else f.value = '';
        });
        document.getElementById('account-dialog-overlay').classList.remove('hidden');
    });

    document.getElementById('btn-refresh-accounts').addEventListener('click', loadAccounts);

    // Dialog save
    document.getElementById('btn-dialog-save').addEventListener('click', async () => {
        const account = buildAccountFromForm();
        const method = editingAccount ? 'PUT' : 'POST';
        const url = editingAccount
            ? '/api/accounts/' + encodeURIComponent(editingAccount)
            : '/api/accounts';

        try {
            const res = await apiFetch(url, {
                method,
                body: JSON.stringify(account),
            });
            const result = await res.json();
            if(result.success) {
                document.getElementById('account-dialog-overlay').classList.add('hidden');
                showAlert('Success', result.message);
                loadAccounts();
            } else {
                showAlert('Validation Error', (result.errors && result.errors.join('\n')) || 'Invalid account configuration');
            }
        } catch(err) {
            showAlert('Error', 'Failed to save account: ' + err.message);
        }
    });

    document.getElementById('btn-dialog-cancel').addEventListener('click', () => {
        document.getElementById('account-dialog-overlay').classList.add('hidden');
    });

    document.getElementById('dialog-close').addEventListener('click', () => {
        document.getElementById('account-dialog-overlay').classList.add('hidden');
    });

    function buildAccountFromForm() {
        const ips = document.getElementById('acct-allowed-ips').value.trim().split('\n').filter(l => l.trim());
        const froms = document.getElementById('acct-allowed-from').value.trim().split('\n').filter(l => l.trim());
        const secret = document.getElementById('acct-secret').value.trim();
        const thumbprint = document.getElementById('acct-cert-thumbprint').value.trim();
        const keyPath = document.getElementById('acct-cert-key-path').value.trim();

        const account = {
            name: document.getElementById('acct-name').value.trim(),
            appReg: {
                tenant: document.getElementById('acct-tenant').value.trim(),
                id: document.getElementById('acct-client-id').value.trim(),
            },
            allowedIPs: ips.length ? ips : undefined,
            allowedFrom: froms.length ? froms : undefined,
            forceMailbox: document.getElementById('acct-force-mailbox').value.trim() || undefined,
            retryLimit: parseInt(document.getElementById('acct-retry-limit').value) || 3,
            retryInterval: parseInt(document.getElementById('acct-retry-interval').value) || 5,
        };

        if(secret)
            account.appReg.secret = secret;
        if(thumbprint && keyPath)
            account.appReg.certificate = {thumbprint, privateKeyPath: keyPath};

        return account;
    }

    // ---- Config Tab ----
    async function loadConfig() {
        try {
            const res = await fetch('/api/config');
            const config = await res.json();
            renderConfigForm(config);
            setStatus('Configuration loaded');
        } catch(err) {
            setStatus('Failed to load configuration');
        }
    }

    function renderConfigForm(config) {
        const container = document.getElementById('config-form');
        while(container.firstChild) container.removeChild(container.firstChild);

        addConfigSection(container, 'Operation Mode', [
            {key: 'mode', label: 'Mode', type: 'select', options: ['full', 'receive', 'send'], value: config.mode},
        ]);

        if(config.receive) {
            addConfigSection(container, 'SMTP Server (Receive)', [
                {key: 'receive.port', label: 'Port', type: 'number', value: config.receive.port || 25},
                {key: 'receive.listenAddress', label: 'Listen Address', type: 'text', value: config.receive.listenAddress || ''},
                {key: 'receive.secure', label: 'Require TLS', type: 'checkbox', value: config.receive.secure || false},
                {key: 'receive.maxSize', label: 'Max Message Size', type: 'text', value: config.receive.maxSize || '100m'},
                {key: 'receive.banner', label: 'SMTP Banner', type: 'text', value: config.receive.banner || ''},
                {key: 'receive.requireAuth', label: 'Require Auth', type: 'checkbox', value: config.receive.requireAuth || false},
            ]);
        }

        if(config.httpProxy) {
            addConfigSection(container, 'HTTP Proxy', [
                {key: 'httpProxy.host', label: 'Host', type: 'text', value: config.httpProxy.host || ''},
                {key: 'httpProxy.port', label: 'Port', type: 'number', value: config.httpProxy.port || ''},
                {key: 'httpProxy.protocol', label: 'Protocol', type: 'select', options: ['http', 'https'], value: config.httpProxy.protocol || 'http'},
            ]);
        }

        if(config.webui) {
            addConfigSection(container, 'WebUI', [
                {key: 'webui.enabled', label: 'Enabled', type: 'checkbox', value: config.webui.enabled || false},
                {key: 'webui.port', label: 'Port', type: 'number', value: config.webui.port || 3000},
                {key: 'webui.listenAddress', label: 'Listen Address', type: 'text', value: config.webui.listenAddress || '127.0.0.1'},
            ]);
        }
    }

    function addConfigSection(container, title, fields) {
        const section = el('div', 'group-box config-section');
        const legend = el('legend', null, title);
        section.appendChild(legend);

        fields.forEach(f => {
            const group = el('div', 'form-group');
            const label = el('label', null, f.label + ':');
            group.appendChild(label);

            let input;
            if(f.type === 'select') {
                input = document.createElement('select');
                input.className = 'field';
                input.dataset.key = f.key;
                f.options.forEach(opt => {
                    const option = document.createElement('option');
                    option.value = opt;
                    option.textContent = opt;
                    if(opt === f.value) option.selected = true;
                    input.appendChild(option);
                });
            } else if(f.type === 'checkbox') {
                input = document.createElement('input');
                input.type = 'checkbox';
                input.dataset.key = f.key;
                input.checked = Boolean(f.value);
            } else {
                input = document.createElement('input');
                input.type = f.type;
                input.className = 'field';
                input.dataset.key = f.key;
                input.value = String(f.value !== undefined ? f.value : '');
            }

            group.appendChild(input);
            section.appendChild(group);
        });

        container.appendChild(section);
    }

    document.getElementById('btn-save-config').addEventListener('click', async () => {
        try {
            // Read current config (masked), then apply form changes
            // Server will preserve any '********' secrets from disk
            const res = await fetch('/api/config');
            const config = await res.json();

            document.querySelectorAll('#config-form [data-key]').forEach(elem => {
                const keys = elem.dataset.key.split('.');
                let obj = config;
                for(let i = 0; i < keys.length - 1; i++) {
                    if(!obj[keys[i]]) obj[keys[i]] = {};
                    obj = obj[keys[i]];
                }
                const lastKey = keys[keys.length - 1];
                if(elem.type === 'checkbox')
                    obj[lastKey] = elem.checked;
                else if(elem.type === 'number')
                    obj[lastKey] = elem.value ? parseInt(elem.value) : undefined;
                else
                    obj[lastKey] = elem.value || undefined;
            });

            const saveRes = await apiFetch('/api/config', {
                method: 'PUT',
                body: JSON.stringify(config),
            });
            const result = await saveRes.json();

            if(result.success) {
                document.getElementById('restart-banner').classList.remove('hidden');
                setStatus('Configuration saved');
            } else {
                showAlert('Validation Error', (result.errors && result.errors.join('\n')) || 'Invalid configuration');
            }
        } catch(err) {
            showAlert('Error', 'Failed to save config: ' + err.message);
        }
    });

    document.getElementById('btn-reload-config').addEventListener('click', loadConfig);

    // ---- Alert Dialog ----
    function showAlert(title, message) {
        document.getElementById('alert-title').textContent = title;
        document.getElementById('alert-message').textContent = message;
        document.getElementById('alert-dialog-overlay').classList.remove('hidden');
    }

    document.getElementById('alert-ok').addEventListener('click', () => {
        document.getElementById('alert-dialog-overlay').classList.add('hidden');
    });
    document.getElementById('alert-close').addEventListener('click', () => {
        document.getElementById('alert-dialog-overlay').classList.add('hidden');
    });

    // ---- Status Bar ----
    function setStatus(text) {
        document.getElementById('statusbar-text').textContent = text;
    }

    // Clock
    function updateClock() {
        const now = new Date();
        document.getElementById('statusbar-time').textContent = now.toLocaleTimeString();
    }
    setInterval(updateClock, 1000);
    updateClock();

    // ---- Utilities ----
    function formatUptime(seconds) {
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        if(d > 0) return d + 'd ' + h + 'h ' + m + 'm';
        if(h > 0) return h + 'h ' + m + 'm';
        return m + 'm';
    }

    // ---- Init ----
    switchTab('dashboard');
})();
