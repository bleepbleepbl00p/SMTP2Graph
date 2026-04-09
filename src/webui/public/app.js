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

    // ---- Setup Wizard ----
    async function checkSetupMode() {
        try {
            const res = await fetch('/api/setup-status');
            const data = await res.json();
            if(data.setupMode) {
                showSetupWizard();
                return true;
            }
        } catch(e) {
            // If endpoint doesn't exist, we're in normal mode
        }
        return false;
    }

    function showSetupWizard() {
        document.querySelector('.tab-bar').style.display = 'none';
        document.querySelectorAll('[id^="tab-"]').forEach(el => el.style.display = 'none');
        document.querySelector('.title-bar-text').textContent = 'SMTP2Graph — Setup Wizard';
        const wizard = document.getElementById('setup-wizard');
        if(wizard) wizard.style.display = 'block';
        initSetupWizard();
    }

    // Persistent storage for wizard form values across steps
    var wizardData = {
        webuiUser: 'admin', webuiPass: '',
        acctName: '', acctTenant: '', acctClientId: '',
        authMethod: 'certificate',
        acctThumbprint: '', acctKeypath: '', acctSecret: '',
        acctMailbox: '',
        smtpPort: '587', smtpListen: '0.0.0.0', smtpMaxsize: '25m',
        smtpAuth: false, smtpUser: '', smtpPass: '',
    };

    function saveCurrentStep(step) {
        switch(step) {
            case 1:
                wizardData.webuiUser = document.getElementById('setup-webui-user')?.value || 'admin';
                wizardData.webuiPass = document.getElementById('setup-webui-pass')?.value || '';
                break;
            case 2:
                wizardData.acctName = document.getElementById('setup-acct-name')?.value || '';
                wizardData.acctTenant = document.getElementById('setup-acct-tenant')?.value || '';
                wizardData.acctClientId = document.getElementById('setup-acct-clientid')?.value || '';
                wizardData.authMethod = document.querySelector('input[name="setup-auth-method"]:checked')?.value || 'certificate';
                wizardData.acctThumbprint = document.getElementById('setup-acct-thumbprint')?.value || '';
                wizardData.acctKeypath = document.getElementById('setup-acct-keypath')?.value || '';
                wizardData.acctSecret = document.getElementById('setup-acct-secret')?.value || '';
                wizardData.acctMailbox = document.getElementById('setup-acct-mailbox')?.value || '';
                break;
            case 3:
                wizardData.smtpPort = document.getElementById('setup-smtp-port')?.value || '587';
                wizardData.smtpListen = document.getElementById('setup-smtp-listen')?.value || '0.0.0.0';
                wizardData.smtpMaxsize = document.getElementById('setup-smtp-maxsize')?.value || '25m';
                wizardData.smtpAuth = document.getElementById('setup-smtp-auth')?.checked || false;
                wizardData.smtpUser = document.getElementById('setup-smtp-user')?.value || '';
                wizardData.smtpPass = document.getElementById('setup-smtp-pass')?.value || '';
                break;
        }
    }

    function initSetupWizard() {
        let currentStep = 1;
        const totalSteps = 4;

        renderStep(currentStep);

        document.getElementById('wizard-next').addEventListener('click', async () => {
            if(await validateStep(currentStep)) {
                saveCurrentStep(currentStep);
                currentStep++;
                if(currentStep > totalSteps) {
                    await completeSetup();
                } else {
                    renderStep(currentStep);
                }
            }
        });

        document.getElementById('wizard-back').addEventListener('click', () => {
            if(currentStep > 1) {
                saveCurrentStep(currentStep);
                currentStep--;
                renderStep(currentStep);
            }
        });
    }

    function renderStep(step) {
        const content = document.getElementById('wizard-content');
        const backBtn = document.getElementById('wizard-back');
        const nextBtn = document.getElementById('wizard-next');
        const stepIndicator = document.getElementById('wizard-step');

        backBtn.style.display = step === 1 ? 'none' : '';
        nextBtn.textContent = step === 4 ? 'Complete Setup' : 'Next >';
        stepIndicator.textContent = 'Step ' + step + ' of 4';

        switch(step) {
            case 1: content.innerHTML = buildStep1_Welcome(); break;
            case 2: content.innerHTML = buildStep2_Account(); break;
            case 3: content.innerHTML = buildStep3_SMTP(); break;
            case 4: content.innerHTML = buildStep4_Review(); break;
        }

        if(step === 2) {
            setTimeout(() => {
                const certRadio = document.getElementById('setup-auth-cert');
                const secretRadio = document.getElementById('setup-auth-secret');
                const certFields = document.getElementById('setup-cert-fields');
                const secretFields = document.getElementById('setup-secret-fields');
                if(certRadio && secretRadio) {
                    certRadio.addEventListener('change', () => {
                        certFields.style.display = '';
                        secretFields.style.display = 'none';
                    });
                    secretRadio.addEventListener('change', () => {
                        certFields.style.display = 'none';
                        secretFields.style.display = '';
                    });
                }
            }, 0);
        }

        if(step === 3) {
            setTimeout(() => {
                const authCheck = document.getElementById('setup-smtp-auth');
                const authFields = document.getElementById('setup-smtp-auth-fields');
                if(authCheck) {
                    authCheck.addEventListener('change', () => {
                        authFields.style.display = authCheck.checked ? '' : 'none';
                    });
                }
            }, 0);
        }

        if(step === 4) {
            setTimeout(() => populateReview(), 0);
        }
    }

    function buildStep1_Welcome() {
        return '<fieldset class="group-box"><legend>Welcome to SMTP2Graph</legend>' +
            '<p style="margin: 8px 0;">This wizard will help you configure your SMTP relay.</p>' +
            '<p style="margin: 8px 0;">First, set your WebUI admin credentials:</p>' +
            '<div style="margin: 8px 0;"><label>Username:</label><br>' +
            '<input type="text" id="setup-webui-user" value="' + escapeHtml(wizardData.webuiUser) + '" style="width: 200px;"></div>' +
            '<div style="margin: 8px 0;"><label>Password:</label><br>' +
            '<input type="password" id="setup-webui-pass" value="' + escapeHtml(wizardData.webuiPass) + '" style="width: 200px;"></div>' +
            '<div style="margin: 8px 0;"><label>Confirm Password:</label><br>' +
            '<input type="password" id="setup-webui-pass-confirm" value="' + escapeHtml(wizardData.webuiPass) + '" style="width: 200px;"></div>' +
            '</fieldset>';
    }

    function buildStep2_Account() {
        var certChecked = wizardData.authMethod === 'certificate';
        return '<fieldset class="group-box"><legend>Microsoft Graph Relay Account</legend>' +
            '<p style="margin: 8px 0;">Enter your Azure App Registration details:</p>' +
            '<div style="margin: 8px 0;"><label>Account Name:</label><br>' +
            '<input type="text" id="setup-acct-name" value="' + escapeHtml(wizardData.acctName) + '" placeholder="e.g. contoso-relay" style="width: 250px;"></div>' +
            '<div style="margin: 8px 0;"><label>Tenant (name or GUID):</label><br>' +
            '<input type="text" id="setup-acct-tenant" value="' + escapeHtml(wizardData.acctTenant) + '" placeholder="e.g. contoso or GUID" style="width: 250px;"></div>' +
            '<div style="margin: 8px 0;"><label>Application (Client) ID:</label><br>' +
            '<input type="text" id="setup-acct-clientid" value="' + escapeHtml(wizardData.acctClientId) + '" placeholder="01234567-89ab-cdef-0123-456789abcdef" style="width: 320px;"></div>' +
            '<fieldset class="group-box" style="margin-top: 12px;"><legend>Authentication Method</legend>' +
            '<div style="margin: 4px 0;"><input type="radio" name="setup-auth-method" id="setup-auth-cert" value="certificate"' + (certChecked ? ' checked' : '') + '>' +
            '<label for="setup-auth-cert">Certificate</label></div>' +
            '<div id="setup-cert-fields" style="margin: 8px 0 8px 20px;' + (certChecked ? '' : ' display: none;') + '">' +
            '<label>Certificate Thumbprint:</label><br>' +
            '<input type="text" id="setup-acct-thumbprint" value="' + escapeHtml(wizardData.acctThumbprint) + '" style="width: 320px;"><br>' +
            '<label>Private Key Path (in /data):</label><br>' +
            '<input type="text" id="setup-acct-keypath" value="' + escapeHtml(wizardData.acctKeypath) + '" placeholder="client.key" style="width: 250px;"></div>' +
            '<div style="margin: 4px 0;"><input type="radio" name="setup-auth-method" id="setup-auth-secret" value="secret"' + (certChecked ? '' : ' checked') + '>' +
            '<label for="setup-auth-secret">Client Secret</label></div>' +
            '<div id="setup-secret-fields" style="margin: 8px 0 8px 20px;' + (certChecked ? ' display: none;' : '') + '">' +
            '<label>Client Secret:</label><br>' +
            '<input type="password" id="setup-acct-secret" value="' + escapeHtml(wizardData.acctSecret) + '" style="width: 320px;"></div>' +
            '</fieldset>' +
            '<div style="margin: 8px 0;"><label>Force Mailbox (optional):</label><br>' +
            '<input type="text" id="setup-acct-mailbox" value="' + escapeHtml(wizardData.acctMailbox) + '" placeholder="smtp-relay@contoso.com" style="width: 250px;"></div>' +
            '</fieldset>';
    }

    function buildStep3_SMTP() {
        return '<fieldset class="group-box"><legend>SMTP Server Settings</legend>' +
            '<div style="margin: 8px 0;"><label>SMTP Port:</label><br>' +
            '<input type="number" id="setup-smtp-port" value="' + escapeHtml(wizardData.smtpPort) + '" style="width: 80px;"></div>' +
            '<div style="margin: 8px 0;"><label>Listen Address:</label><br>' +
            '<input type="text" id="setup-smtp-listen" value="' + escapeHtml(wizardData.smtpListen) + '" style="width: 150px;"></div>' +
            '<div style="margin: 8px 0;"><input type="checkbox" id="setup-smtp-auth"' + (wizardData.smtpAuth ? ' checked' : '') + '>' +
            '<label for="setup-smtp-auth">Require SMTP Authentication</label></div>' +
            '<div id="setup-smtp-auth-fields" style="margin: 8px 0 8px 20px;' + (wizardData.smtpAuth ? '' : ' display: none;') + '">' +
            '<label>SMTP Username:</label><br><input type="text" id="setup-smtp-user" value="' + escapeHtml(wizardData.smtpUser) + '" style="width: 200px;"><br>' +
            '<label>SMTP Password:</label><br><input type="password" id="setup-smtp-pass" value="' + escapeHtml(wizardData.smtpPass) + '" style="width: 200px;"></div>' +
            '<div style="margin: 8px 0;"><label>Max Message Size:</label><br>' +
            '<input type="text" id="setup-smtp-maxsize" value="' + escapeHtml(wizardData.smtpMaxsize) + '" style="width: 80px;"></div>' +
            '</fieldset>';
    }

    function buildStep4_Review() {
        return '<fieldset class="group-box"><legend>Review Configuration</legend>' +
            '<p style="margin: 8px 0;">Please review your settings before completing setup:</p>' +
            '<div id="setup-review-content" style="font-family: monospace; font-size: 11px;' +
            ' background: white; border: 2px inset #c0c0c0; padding: 8px;' +
            ' max-height: 300px; overflow-y: auto;"></div>' +
            '<p style="margin: 8px 0; color: #800000;">' +
            '<b>Note:</b> The container will restart after setup to apply the configuration.</p>' +
            '</fieldset>';
    }

    function populateReview() {
        var reviewEl = document.getElementById('setup-review-content');
        if(!reviewEl) return;

        var lines = [];
        lines.push('<b>WebUI</b>');
        lines.push('  Username: ' + escapeHtml(wizardData.webuiUser));
        lines.push('  Password: ********');
        lines.push('');
        lines.push('<b>Relay Account</b>');
        lines.push('  Name: ' + escapeHtml(wizardData.acctName || 'default'));
        lines.push('  Tenant: ' + escapeHtml(wizardData.acctTenant || '(not set)'));
        lines.push('  Client ID: ' + escapeHtml(wizardData.acctClientId || '(not set)'));

        if(wizardData.authMethod === 'certificate') {
            lines.push('  Auth: Certificate');
            lines.push('  Thumbprint: ' + escapeHtml(wizardData.acctThumbprint || '(not set)'));
            lines.push('  Key Path: ' + escapeHtml(wizardData.acctKeypath || '(not set)'));
        } else {
            lines.push('  Auth: Client Secret');
            lines.push('  Secret: ' + '********');
        }

        lines.push('');
        lines.push('<b>SMTP Server</b>');
        lines.push('  Port: ' + escapeHtml(wizardData.smtpPort));
        lines.push('  Listen: ' + escapeHtml(wizardData.smtpListen));
        lines.push('  Auth Required: ' + (wizardData.smtpAuth ? 'Yes' : 'No'));
        lines.push('  Max Size: ' + escapeHtml(wizardData.smtpMaxsize));

        reviewEl.innerHTML = lines.join('<br>');
    }

    async function validateStep(step) {
        switch(step) {
            case 1: {
                const pass = document.getElementById('setup-webui-pass').value;
                const confirm = document.getElementById('setup-webui-pass-confirm').value;
                if(pass.length < 8) {
                    showAlert('Validation Error', 'Password must be at least 8 characters.');
                    return false;
                }
                if(pass !== confirm) {
                    showAlert('Validation Error', 'Passwords do not match.');
                    return false;
                }
                return true;
            }
            case 2: {
                const tenant = document.getElementById('setup-acct-tenant').value;
                const clientId = document.getElementById('setup-acct-clientid').value;
                if(!tenant || !clientId) {
                    showAlert('Validation Error', 'Tenant and Client ID are required.');
                    return false;
                }
                const authMethod = document.querySelector('input[name="setup-auth-method"]:checked')?.value;
                if(authMethod === 'certificate') {
                    const thumbprint = document.getElementById('setup-acct-thumbprint').value;
                    const keypath = document.getElementById('setup-acct-keypath').value;
                    if(!thumbprint || !keypath) {
                        showAlert('Validation Error', 'Certificate thumbprint and private key path are required.');
                        return false;
                    }
                } else {
                    const secret = document.getElementById('setup-acct-secret').value;
                    if(!secret) {
                        showAlert('Validation Error', 'Client secret is required.');
                        return false;
                    }
                }
                return true;
            }
            case 3:
                return true;
            case 4:
                return true;
        }
        return true;
    }

    async function completeSetup() {
        var appReg = {
            tenant: wizardData.acctTenant,
            id: wizardData.acctClientId,
        };

        if(wizardData.authMethod === 'certificate') {
            appReg.certificate = {
                thumbprint: wizardData.acctThumbprint,
                privateKeyPath: wizardData.acctKeypath,
            };
        } else {
            appReg.secret = wizardData.acctSecret;
        }

        var account = {
            name: wizardData.acctName || 'default',
            appReg: appReg,
        };

        if(wizardData.acctMailbox) account.forceMailbox = wizardData.acctMailbox;

        var config = {
            mode: 'full',
            accounts: [account],
            receive: {
                port: parseInt(wizardData.smtpPort) || 587,
                listenAddress: wizardData.smtpListen || '0.0.0.0',
                maxSize: wizardData.smtpMaxsize || '25m',
            },
            webui: {
                enabled: true,
                port: 3000,
                listenAddress: '0.0.0.0',
                username: wizardData.webuiUser || 'admin',
                password: wizardData.webuiPass,
            },
        };

        if(wizardData.smtpAuth) {
            config.receive.requireAuth = true;
            config.receive.users = [{
                username: wizardData.smtpUser,
                password: wizardData.smtpPass,
            }];
        }

        try {
            const saveRes = await apiFetch('/api/config', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config),
            });

            if(!saveRes.ok) {
                const err = await saveRes.json();
                showAlert('Error', 'Failed to save config: ' + (err.error || (err.errors && err.errors.join('\n')) || 'Unknown error'));
                return;
            }

            const completeRes = await apiFetch('/api/setup/complete', { method: 'POST' });
            const result = await completeRes.json();

            if(completeRes.ok) {
                document.getElementById('wizard-content').innerHTML =
                    '<fieldset class="group-box"><legend>Setup Complete</legend>' +
                    '<p style="margin: 16px 8px; text-align: center; font-size: 14px;">' +
                    '<b>Configuration saved successfully!</b><br><br>' +
                    'The container is restarting...<br>This page will reload automatically.</p></fieldset>';
                document.getElementById('wizard-next').style.display = 'none';
                document.getElementById('wizard-back').style.display = 'none';

                setTimeout(function pollRestart() {
                    fetch('/api/setup-status')
                        .then(r => r.json())
                        .then(data => {
                            if(!data.setupMode) window.location.reload();
                            else setTimeout(pollRestart, 2000);
                        })
                        .catch(() => setTimeout(pollRestart, 2000));
                }, 3000);
            } else {
                showAlert('Error', result.error || 'Setup completion failed');
            }
        } catch(e) {
            showAlert('Error', 'Network error: ' + e.message);
        }
    }

    // ---- Init ----
    (async function init() {
        const isSetup = await checkSetupMode();
        if(!isSetup) switchTab('dashboard');
    })();
})();
