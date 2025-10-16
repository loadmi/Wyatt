// public/script.js
// Theme management (default: dark)
function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === 'light') {
        root.classList.add('theme-light');
    } else {
        root.classList.remove('theme-light');
    }
}

function updateThemeLabel(labelEl, theme) {
    if (!labelEl) return;
    labelEl.textContent = theme === 'dark' ? 'Dark' : 'Light';
}

function withAlpha(color, alpha) {
    const trimmed = (color || '').trim();
    if (!trimmed) return `rgba(0, 0, 0, ${alpha})`;
    if (trimmed.startsWith('#')) {
        let hex = trimmed.slice(1);
        if (hex.length === 3) {
            hex = hex.split('').map(ch => ch + ch).join('');
        }
        const num = parseInt(hex, 16);
        if (!Number.isNaN(num)) {
            const r = (num >> 16) & 255;
            const g = (num >> 8) & 255;
            const b = num & 255;
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
    }
    if (trimmed.startsWith('rgb')) {
        return trimmed.replace(/rgba?\(([^)]+)\)/, (_, body) => {
            const parts = body.split(',').map(part => part.trim());
            parts[3] = alpha.toString();
            return `rgba(${parts.join(', ')})`;
        });
    }
    return trimmed;
}

function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '—';
    const totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0 || parts.length) parts.push(`${hours}h`);
    if (minutes > 0 || parts.length) parts.push(`${minutes}m`);
    if (!parts.length) parts.push(`${seconds}s`);
    return parts.join(' ');
}

function formatRelativeTime(timestamp) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '—';
    const diff = Date.now() - timestamp;
    if (diff < 0) return 'just now';
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

class BotController {
    constructor() {
        this.startBtn = document.getElementById('startBtn');
        this.stopBtn = document.getElementById('stopBtn');
        this.statusDiv = document.getElementById('status');
        this.logDiv = document.getElementById('log');
        this.personaSelect = document.getElementById('personaSelect');
        this.providerSelect = document.getElementById('providerSelect');
        this.openrouterModelSelect = document.getElementById('openrouterModelSelect');
        this.openrouterModelRow = document.getElementById('openrouterModelRow');
        this.metricsTimestamp = document.getElementById('metricsTimestamp');
        this.metricCards = {
            uptime: document.getElementById('metricUptime'),
            contacts: document.getElementById('metricContacts'),
            inbound: document.getElementById('metricInbound'),
            outbound: document.getElementById('metricOutbound'),
            response: document.getElementById('metricResponse'),
        };
        this.summaryCards = {
            uptime: document.getElementById('summaryUptime'),
            contacts: document.getElementById('summaryContacts'),
            inbound: document.getElementById('summaryInbound'),
            outbound: document.getElementById('summaryOutbound'),
            response: document.getElementById('summaryResponse'),
        };
        this.leaderboardBody = document.getElementById('leaderboardBody');
        this.throughputCanvas = document.getElementById('throughputChart');
        this.providerCanvas = document.getElementById('providerChart');
        this.timelineChart = null;
        this.providerChart = null;
        this.providerPalette = ['#60a5fa', '#f472b6', '#34d399', '#facc15', '#a78bfa', '#f97316'];
        this.numberFormatter = new Intl.NumberFormat();
        this.metricsInterval = null;
        this.lastMetricsError = null;
        this.groupSelect = document.getElementById('groupSelect');
        this.groupRefreshBtn = document.getElementById('groupRefreshBtn');
        this.groupSendBtn = document.getElementById('groupSendBtn');
        this.loadingGroups = false;
        this.sendingGroupMessage = false;
        this.botIsRunning = false;
        this.chatSelect = document.getElementById('chatSelect');
        this.chatRefreshBtn = document.getElementById('chatRefreshBtn');
        this.chatMessagesContainer = document.getElementById('chatMessages');
        this.chatStatusBadge = document.getElementById('chatStatus');
        this.chatDetails = document.getElementById('chatDetails');
        this.chatLastUpdated = document.getElementById('chatLastUpdated');
        this.chatComposerForm = document.getElementById('chatComposer');
        this.chatInput = document.getElementById('chatInput');
        this.chatSendBtn = document.getElementById('chatSendBtn');
        this.chatList = [];
        this.chatActiveId = null;
        this.chatLoadingChats = false;
        this.chatLoadingMessages = false;
        this.chatSendingMessage = false;
        this.chatTabActive = false;
        this.chatPollTimer = null;
        this.chatListTimer = null;
        this.chatAutoScrollLocked = false;
        this.chatForceScrollNext = true;
        this.accountList = document.getElementById('accountList');
        this.accountForm = document.getElementById('accountForm');
        this.accountFormTitle = document.getElementById('accountFormTitle');
        this.accountNotice = document.getElementById('accountNotice');
        this.accountIdInput = document.getElementById('accountId');
        this.accountLabelInput = document.getElementById('accountLabel');
        this.accountApiIdInput = document.getElementById('accountApiId');
        this.accountApiHashInput = document.getElementById('accountApiHash');
        this.accountSessionInput = document.getElementById('accountSession');
        this.accountSaveBtn = document.getElementById('accountSaveBtn');
        this.accountCancelBtn = document.getElementById('accountCancelBtn');
        this.accounts = [];
        this.activeAccountId = null;
        this.hasActiveAccount = false;
        this._accountNoticeTimer = null;
        this._loginPollInterval = null;
        this._loginPollBusy = false;

        this.startBtn.addEventListener('click', () => this.startBot());
        this.stopBtn.addEventListener('click', () => this.stopBot());
        this.personaSelect.addEventListener('change', () => this.changePersona());
        this.providerSelect.addEventListener('change', () => this.changeProvider());
        this.openrouterModelSelect.addEventListener('change', () => this.changeOpenRouterModel());
        if (this.accountForm) {
            this.accountForm.addEventListener('submit', (event) => {
                event.preventDefault();
                this.submitAccountForm();
            });
        }
        if (this.accountCancelBtn) {
            this.accountCancelBtn.addEventListener('click', () => this.resetAccountForm());
        }
        if (this.groupSelect) {
            this.groupSelect.addEventListener('change', () => this.updateGroupControlsState());
        }
        if (this.groupRefreshBtn) {
            this.groupRefreshBtn.addEventListener('click', () => this.loadGroups());
        }
        if (this.groupSendBtn) {
            this.groupSendBtn.addEventListener('click', () => this.sendGroupSentiment());
        }
        if (this.chatSelect) {
            this.chatSelect.addEventListener('change', () => this.onChatSelected());
        }
        if (this.chatRefreshBtn) {
            this.chatRefreshBtn.addEventListener('click', () => this.loadChats());
        }
        if (this.chatComposerForm) {
            this.chatComposerForm.addEventListener('submit', (event) => {
                event.preventDefault();
                this.sendChatMessage();
            });
        }
        if (this.chatMessagesContainer) {
            this.chatMessagesContainer.addEventListener('scroll', () => this.onChatScrolled());
        }

        // Check initial status
        this.checkStatus();

        // Load available personalities
        this.loadPersonalities();

        // Load LLM configuration
        this.loadLLMConfig();

        // Load Telegram accounts
        this.loadAccounts();

        // Attempt to load group list (may warn if bot is stopped)
        this.loadGroups(false);

        // Initialize chat panel placeholders
        this.populateChatSelectPlaceholder('Start the bot to load chats');
        this.showChatPlaceholder('Start the bot to load chats.');
        this.updateChatStatusBadge();
        this.updateChatDetails();

        // Prepare chat list (will only succeed when bot is running)
        this.loadChats(false);

        // Check status every 5 seconds
        setInterval(() => this.checkStatus(), 5000);

        this.setupMetricsDashboard();
    }

    async checkStatus() {
        try {
            const response = await fetch('/api/status');
            const data = await response.json();
            this.updateStatus(data.isRunning);
        } catch (error) {
            this.log('Error checking status: ' + error.message);
        }
    }

    updateStatus(isRunning) {
        const previouslyRunning = this.botIsRunning;
        this.botIsRunning = !!isRunning;
        if (isRunning) {
            this.statusDiv.textContent = 'Status: Running';
            this.statusDiv.className = 'status running';
            this.startBtn.disabled = true;
            this.stopBtn.disabled = false;
        } else {
            this.statusDiv.textContent = 'Status: Stopped';
            this.statusDiv.className = 'status stopped';
            this.startBtn.disabled = !this.hasActiveAccount;
            this.stopBtn.disabled = true;
        }
        this.updateGroupControlsState();
        if (this.botIsRunning) {
            if (!previouslyRunning) {
                this.loadGroups(false);
                this.loadChats(false);
                this.chatForceScrollNext = true;
            }
            this.startChatListPolling();
            if (this.chatTabActive) {
                this.startChatPolling();
                if (this.chatActiveId && !previouslyRunning) {
                    this.fetchChatMessages(this.chatActiveId);
                }
            }
        } else {
            this.stopChatPolling();
            this.stopChatListPolling();
            if (previouslyRunning) {
                this.handleBotStoppedChats();
            }
        }
        this.updateChatControlsState();
        this.updateChatStatusBadge();
    }

    async startBot() {
        this.log('Starting bot...');
        this.startBtn.disabled = true;

        try {
            const response = await fetch('/api/start', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            const data = await response.json();

            if (data.success) {
                this.log('✅ ' + data.message);
                this.updateStatus(true);
            } else {
                this.log('❌ ' + data.message);
                this.startBtn.disabled = false;
            }
        } catch (error) {
            this.log('❌ Error starting bot: ' + error.message);
            this.startBtn.disabled = false;
        }
    }

    async stopBot() {
        this.log('Stopping bot...');
        this.stopBtn.disabled = true;

        try {
            const response = await fetch('/api/stop', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            const data = await response.json();

            if (data.success) {
                this.log('✅ ' + data.message);
                this.updateStatus(false);
            } else {
                this.log('❌ ' + data.message);
                this.stopBtn.disabled = false;
            }
        } catch (error) {
            this.log('❌ Error stopping bot: ' + error.message);
            this.stopBtn.disabled = false;
        }
    }

    log(message) {
        const timestamp = new Date().toLocaleTimeString();
        const logEntry = document.createElement('div');
        logEntry.textContent = `[${timestamp}] ${message}`;
        this.logDiv.appendChild(logEntry);
        this.logDiv.scrollTop = this.logDiv.scrollHeight;
    }

    async loadPersonalities() {
        try {
            const response = await fetch('/api/config/personas');
            const data = await response.json();

            if (data.available && Array.isArray(data.available)) {
                // Clear the dropdown
                this.personaSelect.innerHTML = '';

                // Add options for each available personality
                data.available.forEach(persona => {
                    const option = document.createElement('option');
                    option.value = persona;
                    option.textContent = persona;
                    this.personaSelect.appendChild(option);
                });

                // Try to set the current personality; if it's not a known option,
                // default to 'granny.json' when available and persist it.
                const available = data.available;
                const currentIsKnown = typeof data.current === 'string' && available.includes(data.current);
                const hasGranny = available.includes('granny.json');
                if (currentIsKnown) {
                    this.personaSelect.value = data.current;
                } else if (hasGranny) {
                    this.personaSelect.value = 'granny.json';
                    this.changePersona();
                }

                this.log('Personalities loaded successfully');
            } else {
                this.log('Error: No personalities available');
            }
        } catch (error) {
            this.log('❌ Error loading personalities: ' + error.message);
        }
    }

    async loadLLMConfig() {
        try {
            const response = await fetch('/api/config/llm');
            const data = await response.json();

            // Set provider
            if (data.provider) {
                this.providerSelect.value = data.provider;
            }

            // Populate models
            if (Array.isArray(data.availableOpenRouterModels)) {
                this.openrouterModelSelect.innerHTML = '';
                data.availableOpenRouterModels.forEach(model => {
                    const option = document.createElement('option');
                    option.value = model;
                    option.textContent = model;
                    this.openrouterModelSelect.appendChild(option);
                });
            }

            // Set current model
            if (data.openrouterModel) {
                const found = Array.from(this.openrouterModelSelect.options).some(o => o.value === data.openrouterModel);
                if (!found) {
                    const option = document.createElement('option');
                    option.value = data.openrouterModel;
                    option.textContent = data.openrouterModel + ' (custom)';
                    this.openrouterModelSelect.appendChild(option);
                }
                this.openrouterModelSelect.value = data.openrouterModel;
            }

            // Toggle visibility based on provider
            this.toggleModelVisibility();

            if (data.provider === 'openrouter' && !data.hasOpenrouterKey) {
                this.log('⚠️ OpenRouter selected but no OPENROUTER_API_KEY found in server .env');
            }

            this.log('LLM config loaded');
        } catch (error) {
            this.log('❌ Error loading LLM config: ' + error.message);
        }
    }

    async loadAccounts(logMessage = true) {
        if (!this.accountList) {
            return;
        }

        try {
            const response = await fetch('/api/config/accounts');
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data?.message || 'Failed to load accounts');
            }

            this.accounts = Array.isArray(data.accounts) ? data.accounts : [];
            this.activeAccountId = typeof data.activeAccountId === 'string' ? data.activeAccountId : null;
            this.renderAccounts();

            if (logMessage) {
                if (this.accounts.length > 0) {
                    this.log(`Loaded ${this.accounts.length} Telegram account${this.accounts.length === 1 ? '' : 's'}.`);
                } else {
                    this.log('No Telegram accounts configured. Add one to start the bot.');
                }
            }
        } catch (error) {
            const message = error && error.message ? error.message : 'Unable to load accounts';
            this.log('❌ ' + message);
        } finally {
            this.updateStatus(this.botIsRunning);
        }
    }

    renderAccounts() {
        if (!this.accountList) {
            return;
        }

        this.accountList.innerHTML = '';

        if (!Array.isArray(this.accounts) || this.accounts.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'account-empty';
            empty.textContent = 'No Telegram accounts configured yet. Add one to start the bot.';
            this.accountList.appendChild(empty);
            this.hasActiveAccount = false;
            return;
        }

        const activeId = typeof this.activeAccountId === 'string' ? this.activeAccountId : null;
        let activeDetected = false;

        this.accounts.forEach(account => {
            const isActive = account.isActive === true || (activeId && account.id === activeId);
            if (isActive) {
                activeDetected = true;
            }

            const card = document.createElement('div');
            card.className = 'account-card';
            card.setAttribute('role', 'listitem');
            card.dataset.accountId = account.id;
            if (isActive) {
                card.classList.add('active');
            }

            const header = document.createElement('header');
            const title = document.createElement('h3');
            title.className = 'account-card-title';
            title.textContent = account.label || 'Telegram account';
            header.appendChild(title);

            const tag = document.createElement('span');
            tag.className = 'account-card-tag';
            tag.textContent = isActive ? 'Active' : 'Available';
            header.appendChild(tag);
            card.appendChild(header);

            const meta = document.createElement('div');
            meta.className = 'account-meta';

            const apiLine = document.createElement('div');
            apiLine.textContent = `API ID: ${account.apiId}`;
            meta.appendChild(apiLine);

            const sessionLine = document.createElement('div');
            const hasSession = (account && account.hasSession === true) || (typeof account.sessionString === 'string' && account.sessionString.trim().length > 0);
            if (hasSession) {
                sessionLine.textContent = 'Session: Stored';
            } else {
                sessionLine.textContent = 'Session: Missing';
            }
            meta.appendChild(sessionLine);

            if (typeof account.updatedAt === 'number') {
                const updatedLine = document.createElement('div');
                updatedLine.textContent = 'Updated: ' + new Date(account.updatedAt).toLocaleString();
                meta.appendChild(updatedLine);
            }

            card.appendChild(meta);

            const actions = document.createElement('div');
            actions.className = 'account-actions';

            if (!isActive) {
                const hasSessionForActivation = (account && account.hasSession === true) || (typeof account.sessionString === 'string' && account.sessionString.trim().length > 0);
                if (hasSessionForActivation) {
                    const activateBtn = document.createElement('button');
                    activateBtn.type = 'button';
                    activateBtn.className = 'primary';
                    activateBtn.textContent = 'Set active';
                    activateBtn.addEventListener('click', () => this.activateAccount(account.id));
                    actions.appendChild(activateBtn);
                }
            }

            // Show console-login button for accounts missing a session
            const needsSession = !((account && account.hasSession === true) || (typeof account.sessionString === 'string' && account.sessionString.trim().length > 0));
            if (needsSession) {
                const loginBtn = document.createElement('button');
                loginBtn.type = 'button';
                loginBtn.className = 'secondary console-login-btn';
                loginBtn.textContent = 'Console login';
                loginBtn.addEventListener('click', () => this.startConsoleLogin(account.id, account.label || 'account', loginBtn));
                actions.appendChild(loginBtn);
            }

            const editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.className = 'secondary';
            editBtn.textContent = 'Edit';
            editBtn.addEventListener('click', () => this.editAccount(account));
            actions.appendChild(editBtn);

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'danger';
            removeBtn.textContent = 'Remove';
            removeBtn.addEventListener('click', () => this.deleteAccount(account));
            actions.appendChild(removeBtn);

            card.appendChild(actions);
            this.accountList.appendChild(card);
        });

        this.hasActiveAccount = activeDetected;
        if (!activeDetected && this.accounts.length > 0) {
            this.log('⚠️ No active Telegram account selected. Choose one to enable the bot.');
        }
    }

    pollForSession(accountId, label, timeoutMs = 90000) {
        if (this._loginPollInterval) {
            clearInterval(this._loginPollInterval);
            this._loginPollInterval = null;
        }
        const stopAt = Date.now() + timeoutMs;
        this._loginPollInterval = setInterval(async () => {
            if (this._loginPollBusy) return;
            this._loginPollBusy = true;
            try {
                await this.loadAccounts(false);
                const acct = Array.isArray(this.accounts) ? this.accounts.find(a => a.id === accountId) : null;
                const hasSession = !!(acct && (acct.hasSession === true || (typeof acct.sessionString === 'string' && acct.sessionString.trim().length > 0)));
                if (hasSession) {
                    this.log(`�o. Session detected for ${label}. You can set it active now.`);
                    this.showAccountNotice(`Session saved for "${label}". You can set it active.`, 8000);
                    clearInterval(this._loginPollInterval);
                    this._loginPollInterval = null;
                }
            } catch (e) {
                // ignore transient errors
            } finally {
                this._loginPollBusy = false;
            }
            if (Date.now() > stopAt) {
                if (this._loginPollInterval) {
                    clearInterval(this._loginPollInterval);
                    this._loginPollInterval = null;
                }
            }
        }, 3000);
    }

    showAccountNotice(message, durationMs = 15000) {
        if (!this.accountNotice) return;
        this.accountNotice.textContent = message;
        this.accountNotice.style.display = '';
        if (this._accountNoticeTimer) {
            clearTimeout(this._accountNoticeTimer);
        }
        this._accountNoticeTimer = setTimeout(() => {
            if (this.accountNotice) this.accountNotice.style.display = 'none';
            this._accountNoticeTimer = null;
        }, durationMs);
    }

    async startConsoleLogin(accountId, label, buttonEl) {
        if (!accountId) return;
        this.showAccountNotice(`Starting interactive login for "${label}". Continue in the server console. This notice will close in 15s.`);
        this.log(`Initiating console login for ${label}...`);
        if (buttonEl) {
            try { buttonEl.disabled = true; } catch {}
            setTimeout(() => { try { buttonEl.disabled = false; } catch {} }, 15000);
        }
        try {
            const response = await fetch(`/api/config/accounts/${encodeURIComponent(accountId)}/login`, { method: 'POST' });
            const data = await response.json();
            if (!response.ok || !data.success) {
                throw new Error(data?.message || 'Failed to start console login.');
            }
            this.log('�o. ' + data.message);
            this.pollForSession(accountId, label, 120000);
        } catch (error) {
            this.log('�?O ' + (error && error.message ? error.message : 'Error starting console login'));
        }
    }

    editAccount(account) {
        if (!account) return;

        if (this.accountIdInput) this.accountIdInput.value = account.id || '';
        if (this.accountLabelInput) this.accountLabelInput.value = account.label || '';
        if (this.accountApiIdInput) this.accountApiIdInput.value = account.apiId != null ? account.apiId : '';
        if (this.accountApiHashInput) this.accountApiHashInput.value = '';
        if (this.accountSessionInput) {
            // Do not expose stored session in UI
            this.accountSessionInput.value = '';
            if (this.accountSessionInput.dataset) {
                delete this.accountSessionInput.dataset.originalValue;
            }
        }
        if (this.accountFormTitle) {
            this.accountFormTitle.textContent = `Edit ${account.label || 'account'}`;
        }
        if (this.accountSaveBtn) {
            this.accountSaveBtn.textContent = 'Save changes';
        }
        if (this.accountCancelBtn) {
            this.accountCancelBtn.style.display = '';
        }
        if (this.accountForm && typeof this.accountForm.scrollIntoView === 'function') {
            this.accountForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    resetAccountForm() {
        if (this.accountIdInput) this.accountIdInput.value = '';
        if (this.accountLabelInput) this.accountLabelInput.value = '';
        if (this.accountApiIdInput) this.accountApiIdInput.value = '';
        if (this.accountApiHashInput) this.accountApiHashInput.value = '';
        if (this.accountSessionInput) {
            this.accountSessionInput.value = '';
            if (this.accountSessionInput.dataset) {
                delete this.accountSessionInput.dataset.originalValue;
            }
        }
        if (this.accountFormTitle) {
            this.accountFormTitle.textContent = 'Add account';
        }
        if (this.accountSaveBtn) {
            this.accountSaveBtn.textContent = 'Add account';
        }
        if (this.accountCancelBtn) {
            this.accountCancelBtn.style.display = 'none';
        }
    }

    async submitAccountForm() {
        if (!this.accountForm || !this.accountLabelInput || !this.accountApiIdInput || !this.accountApiHashInput) {
            return;
        }

        const id = this.accountIdInput ? this.accountIdInput.value.trim() : '';
        const label = this.accountLabelInput.value.trim();
        const apiIdValue = Number(this.accountApiIdInput.value);
        const apiHash = this.accountApiHashInput.value.trim();
        const isEdit = !!id;
        if (!label || !Number.isFinite(apiIdValue) || apiIdValue <= 0 || (!isEdit && !apiHash)) {
            this.log('\uFFFD?O Provide a display name and API ID. API hash is required when adding a new account.');
            return;
        }

        const payload = { label, apiId: apiIdValue, }; if (!isEdit || apiHash) { payload.apiHash = apiHash; }

        if (this.accountSessionInput) {
            const raw = this.accountSessionInput.value;
            const trimmed = raw.trim();
            const original = this.accountSessionInput.dataset ? this.accountSessionInput.dataset.originalValue || '' : '';
            if (trimmed) {
                payload.sessionString = trimmed;
            } else if (id && original && raw === '') {
                payload.sessionString = '';
            }
        }

        if (this.accountSaveBtn) {
            this.accountSaveBtn.disabled = true;
        }

        try {
            const endpoint = id ? `/api/config/accounts/${encodeURIComponent(id)}` : '/api/config/accounts';
            const method = id ? 'PUT' : 'POST';
            const response = await fetch(endpoint, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await response.json();
            if (!response.ok || !data.success) {
                throw new Error(data?.message || 'Failed to save account.');
            }
            this.log(`✅ ${id ? 'Account updated' : 'Account added'}: ${label}`);
            this.resetAccountForm();
            await this.loadAccounts(false);
            if (data && Object.prototype.hasOwnProperty.call(data, 'restarted')) {
                if (data.restarted) {
                    this.log('Bot restarted on activation' + (data.restartMessage ? `: ${data.restartMessage}` : ''));
                } else if (data.restartMessage) {
                    this.log('Info: ' + data.restartMessage);
                }
            }
            this.checkStatus();
        } catch (error) {
            const message = error && error.message ? error.message : 'Failed to save account.';
            this.log('❌ ' + message);
        } finally {
            if (this.accountSaveBtn) {
                this.accountSaveBtn.disabled = false;
            }
        }
    }

    async activateAccount(accountId) {
        if (!accountId) return;
        try {
            const response = await fetch(`/api/config/accounts/${encodeURIComponent(accountId)}/activate`, {
                method: 'POST',
            });
            const data = await response.json();
            if (!response.ok || !data.success) {
                throw new Error(data?.message || 'Failed to activate account.');
            }
            const name = data?.account?.label || 'Account';
            this.log(`✅ Activated account: ${name}`);
            await this.loadAccounts(false);
        } catch (error) {
            const message = error && error.message ? error.message : 'Failed to activate account.';
            this.log('❌ ' + message);
        }
    }

    async deleteAccount(account) {
        if (!account || !account.id) {
            return;
        }
        const name = account.label || 'Account';
        if (typeof window !== 'undefined' && !window.confirm(`Remove account "${name}"?`)) {
            return;
        }
        try {
            const response = await fetch(`/api/config/accounts/${encodeURIComponent(account.id)}`, {
                method: 'DELETE',
            });
            const data = await response.json();
            if (!response.ok || !data.success) {
                throw new Error(data?.message || 'Failed to remove account.');
            }
            this.log(`🗑️ Removed account: ${name}`);
            if (this.accountIdInput && this.accountIdInput.value === account.id) {
                this.resetAccountForm();
            }
            await this.loadAccounts(false);
        } catch (error) {
            const message = error && error.message ? error.message : 'Failed to remove account.';
            this.log('❌ ' + message);
        }
    }

    async loadGroups(logOnSuccess = true) {
        if (!this.groupSelect) return;

        if (!this.botIsRunning) {
            this.groupSelect.innerHTML = '';
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'Start the bot to load groups';
            this.groupSelect.appendChild(option);
            this.updateGroupControlsState();
            return;
        }

        const previousValue = this.groupSelect.value;
        this.loadingGroups = true;
        this.updateGroupControlsState();
        this.groupSelect.innerHTML = '';
        const loadingOption = document.createElement('option');
        loadingOption.value = '';
        loadingOption.textContent = 'Loading groups...';
        this.groupSelect.appendChild(loadingOption);

        try {
            const response = await fetch('/api/telegram/groups');
            const data = await response.json();

            if (!response.ok || !data.success) {
                const message = data?.message || 'Unable to load groups';
                this.groupSelect.innerHTML = '';
                const option = document.createElement('option');
                option.value = '';
                option.textContent = message;
                this.groupSelect.appendChild(option);
                this.log('❌ ' + message);
                return;
            }

            if (!Array.isArray(data.groups) || data.groups.length === 0) {
                this.groupSelect.innerHTML = '';
                const option = document.createElement('option');
                option.value = '';
                option.textContent = 'No accessible groups';
                this.groupSelect.appendChild(option);
                if (logOnSuccess) {
                    this.log('ℹ️ No group chats available.');
                }
                return;
            }

            this.groupSelect.innerHTML = '';
            data.groups.forEach(group => {
                const option = document.createElement('option');
                option.value = group.id;
                option.textContent = group.title;
                this.groupSelect.appendChild(option);
            });

            if (previousValue && data.groups.some(g => g.id === previousValue)) {
                this.groupSelect.value = previousValue;
            }

            if (!this.groupSelect.value && data.groups.length > 0) {
                this.groupSelect.value = data.groups[0].id;
            }

            if (logOnSuccess) {
                this.log(`Group list refreshed (${data.groups.length} found)`);
            }
        } catch (error) {
            this.groupSelect.innerHTML = '';
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'Failed to load groups';
            this.groupSelect.appendChild(option);
            this.log('❌ Error loading groups: ' + error.message);
        } finally {
            this.loadingGroups = false;
            this.updateGroupControlsState();
        }
    }

    toggleModelVisibility() {
        const p = this.providerSelect.value;
        if (p === 'openrouter') {
            this.openrouterModelRow.style.display = '';
        } else {
            this.openrouterModelRow.style.display = 'none';
        }
    }

    async changeProvider() {
        const provider = this.providerSelect.value;
        this.toggleModelVisibility();
        try {
            const payload = { provider };
            if (provider === 'openrouter') {
                payload.openrouterModel = this.openrouterModelSelect.value;
            }
            const response = await fetch('/api/config/llm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await response.json();
            if (data.success) {
                this.log(`✅ Provider set to: ${provider}`);
            } else {
                this.log('❌ ' + (data.message || 'Failed to set provider'));
            }
        } catch (error) {
            this.log('❌ Error setting provider: ' + error.message);
        }
    }

    async changeOpenRouterModel() {
        const provider = this.providerSelect.value;
        if (provider !== 'openrouter') return;
        const model = this.openrouterModelSelect.value;
        try {
            const response = await fetch('/api/config/llm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider, openrouterModel: model })
            });
            const data = await response.json();
            if (data.success) {
                this.log(`✅ OpenRouter model set to: ${model}`);
            } else {
                this.log('❌ ' + (data.message || 'Failed to set model'));
            }
        } catch (error) {
            this.log('❌ Error setting model: ' + error.message);
        }
    }

    async changePersona() {
        const selectedPersona = this.personaSelect.value;
        if (!selectedPersona) return;

        this.log(`Changing personality to: ${selectedPersona}...`);

        try {
            const response = await fetch('/api/config/persona', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ persona: selectedPersona })
            });

            const data = await response.json();

            if (data.success) {
                this.log(`✅ Personality changed to: ${selectedPersona}`);
            } else {
                this.log('❌ ' + (data.message || 'Failed to change personality'));
            }
        } catch (error) {
            this.log('❌ Error changing personality: ' + error.message);
        }
    }

    updateGroupControlsState() {
        const busy = this.loadingGroups || this.sendingGroupMessage;
        if (this.groupSelect) {
            const disableSelect = !this.botIsRunning || this.loadingGroups;
            this.groupSelect.disabled = disableSelect;
        }
        if (this.groupRefreshBtn) {
            this.groupRefreshBtn.disabled = !this.botIsRunning || busy;
        }
        if (this.groupSendBtn) {
            const hasChoice = !!(this.groupSelect && this.groupSelect.value);
            this.groupSendBtn.disabled = !this.botIsRunning || !hasChoice || busy;
        }
    }

    async sendGroupSentiment() {
        if (!this.groupSelect || !this.groupSendBtn) return;
        const groupId = this.groupSelect.value;
        if (!groupId) {
            this.log('Select a group first.');
            return;
        }

        const selectedOption = this.groupSelect.options[this.groupSelect.selectedIndex];
        const groupName = selectedOption ? selectedOption.textContent : 'group';
        this.sendingGroupMessage = true;
        this.updateGroupControlsState();
        this.log(`Crafting sentiment-matched message for "${groupName}"...`);

        try {
            const response = await fetch(`/api/telegram/groups/${encodeURIComponent(groupId)}/sentiment`, {
                method: 'POST'
            });
            const data = await response.json();

            if (response.ok && data.success) {
                let preview = '';
                if (typeof data.preview === 'string') {
                    const trimmed = data.preview.length > 160 ? data.preview.slice(0, 157) + '…' : data.preview;
                    preview = ` Preview: ${trimmed}`;
                }
                this.log(`✅ ${data.message}${preview}`);
            } else {
                this.log('❌ ' + (data.message || 'Failed to send group message'));
            }
        } catch (error) {
            this.log('❌ Error sending group message: ' + error.message);
        } finally {
            this.sendingGroupMessage = false;
            this.updateGroupControlsState();
        }
    }

    populateChatSelectPlaceholder(message) {
        if (!this.chatSelect) return;
        this.chatSelect.innerHTML = '';
        const option = document.createElement('option');
        option.value = '';
        option.textContent = message;
        this.chatSelect.appendChild(option);
        this.chatSelect.value = '';
    }

    updateChatStatusBadge() {
        if (!this.chatStatusBadge) return;
        if (!this.botIsRunning) {
            this.chatStatusBadge.textContent = 'Bot is offline';
            return;
        }
        if (this.chatLoadingChats) {
            this.chatStatusBadge.textContent = 'Loading chats…';
            return;
        }
        if (!Array.isArray(this.chatList) || this.chatList.length === 0) {
            this.chatStatusBadge.textContent = 'No active chats';
            return;
        }
        const active = this.chatList.find(chat => chat.id === this.chatActiveId);
        if (active) {
            const unreadText = active.unreadCount > 0 ? ` • ${active.unreadCount} unread` : '';
            this.chatStatusBadge.textContent = `${active.title}${unreadText}`;
        } else {
            this.chatStatusBadge.textContent = 'Chats ready';
        }
    }

    updateChatDetails() {
        if (!this.chatDetails) return;
        if (!this.botIsRunning) {
            this.chatDetails.textContent = 'Start the bot to load conversations.';
            return;
        }
        if (!Array.isArray(this.chatList) || this.chatList.length === 0) {
            this.chatDetails.textContent = 'No conversations available yet.';
            return;
        }
        if (!this.chatActiveId) {
            this.chatDetails.textContent = 'Choose a chat to preview recent activity.';
            return;
        }
        const active = this.chatList.find(chat => chat.id === this.chatActiveId);
        if (!active) {
            this.chatDetails.textContent = 'Choose a chat to preview recent activity.';
            return;
        }
        const details = [];
        if (active.lastMessagePreview) {
            details.push(`Last: ${active.lastMessagePreview}`);
        }
        if (active.unreadCount > 0) {
            details.push(`${active.unreadCount} unread`);
        }
        this.chatDetails.textContent = details.length ? details.join(' • ') : 'All caught up on this chat.';
    }

    updateChatControlsState() {
        const hasChats = Array.isArray(this.chatList) && this.chatList.length > 0;
        if (this.chatSelect) {
            this.chatSelect.disabled = !this.botIsRunning || this.chatLoadingChats || !hasChats;
        }
        if (this.chatRefreshBtn) {
            this.chatRefreshBtn.disabled = !this.botIsRunning || this.chatLoadingChats;
        }
        const composerDisabled = !this.botIsRunning || !this.chatActiveId || this.chatSendingMessage;
        if (this.chatInput) {
            this.chatInput.disabled = composerDisabled;
        }
        if (this.chatSendBtn) {
            this.chatSendBtn.disabled = composerDisabled;
        }
    }

    showChatPlaceholder(message) {
        if (!this.chatMessagesContainer) return;
        this.chatMessagesContainer.innerHTML = '';
        const empty = document.createElement('div');
        empty.className = 'chat-empty';
        empty.textContent = message;
        this.chatMessagesContainer.appendChild(empty);
    }

    populateChatSelectOptions(chats, preferredId) {
        if (!this.chatSelect) return null;
        this.chatSelect.innerHTML = '';
        const fragment = document.createDocumentFragment();
        chats.forEach(chat => {
            const option = document.createElement('option');
            option.value = chat.id;
            option.textContent = chat.unreadCount > 0 ? `${chat.title} (${chat.unreadCount} unread)` : chat.title;
            fragment.appendChild(option);
        });
        this.chatSelect.appendChild(fragment);
        let selectedId = null;
        if (preferredId && chats.some(chat => chat.id === preferredId)) {
            selectedId = preferredId;
        } else {
            selectedId = chats[0]?.id || null;
        }
        if (selectedId) {
            this.chatSelect.value = selectedId;
        }
        return selectedId;
    }

    async loadChats(logOnSuccess = true) {
        if (!this.chatSelect) return;

        if (!this.botIsRunning) {
            this.chatList = [];
            this.chatActiveId = null;
            this.populateChatSelectPlaceholder('Start the bot to load chats');
            this.showChatPlaceholder('Start the bot to load chats.');
            if (this.chatLastUpdated) {
                this.chatLastUpdated.textContent = 'Last updated: —';
            }
            this.updateChatControlsState();
            this.updateChatDetails();
            return;
        }

        if (this.chatLoadingChats) {
            return;
        }

        const previousId = this.chatActiveId || this.chatSelect.value;
        this.chatLoadingChats = true;
        this.updateChatControlsState();
        this.updateChatStatusBadge();

        try {
            const response = await fetch('/api/telegram/chats', { cache: 'no-store' });
            const data = await response.json();
            if (!response.ok || !data.success) {
                throw new Error(data?.message || 'Unable to load chats');
            }

            const chats = Array.isArray(data.chats) ? data.chats : [];
            this.chatList = chats;

            if (chats.length === 0) {
                this.chatActiveId = null;
                this.populateChatSelectPlaceholder('No chats yet');
                this.showChatPlaceholder('No conversations yet. Sit tight!');
                if (logOnSuccess) {
                    this.log('ℹ️ No chats available yet.');
                }
            } else {
                const selectedId = this.populateChatSelectOptions(chats, previousId);
                if (selectedId && selectedId !== this.chatActiveId) {
                    this.chatActiveId = selectedId;
                    this.chatForceScrollNext = true;
                }
                if (this.chatTabActive && this.chatActiveId) {
                    await this.fetchChatMessages(this.chatActiveId, { refreshOnly: !this.chatForceScrollNext });
                }
                if (logOnSuccess) {
                    this.log(`Chats refreshed (${chats.length} conversation${chats.length === 1 ? '' : 's'})`);
                }
            }
        } catch (error) {
            const message = error && error.message ? error.message : 'Failed to load chats';
            this.chatList = [];
            this.chatActiveId = null;
            this.populateChatSelectPlaceholder(message);
            this.showChatPlaceholder(message);
            this.log('❌ ' + message);
        } finally {
            this.chatLoadingChats = false;
            this.updateChatControlsState();
            this.updateChatStatusBadge();
            this.updateChatDetails();
        }
    }

    onChatSelected() {
        if (!this.chatSelect) return;
        const selectedId = this.chatSelect.value || null;
        this.chatActiveId = selectedId;
        this.chatForceScrollNext = true;
        if (this.chatTabActive && selectedId) {
            this.fetchChatMessages(selectedId);
        } else if (!selectedId) {
            this.showChatPlaceholder('Pick a conversation to load the history.');
        }
        if (this.chatTabActive) {
            this.startChatPolling();
        }
        this.updateChatControlsState();
        this.updateChatStatusBadge();
        this.updateChatDetails();
    }

    startChatListPolling() {
        this.stopChatListPolling();
        if (!this.botIsRunning) return;
        this.chatListTimer = setInterval(() => this.loadChats(false), 20000);
    }

    stopChatListPolling() {
        if (this.chatListTimer) {
            clearInterval(this.chatListTimer);
            this.chatListTimer = null;
        }
    }

    startChatPolling() {
        this.stopChatPolling();
        if (!this.chatTabActive || !this.botIsRunning || !this.chatActiveId) {
            return;
        }
        this.chatPollTimer = setInterval(() => {
            if (this.botIsRunning && this.chatActiveId) {
                this.fetchChatMessages(this.chatActiveId, { refreshOnly: true });
            }
        }, 6000);
    }

    stopChatPolling() {
        if (this.chatPollTimer) {
            clearInterval(this.chatPollTimer);
            this.chatPollTimer = null;
        }
    }

    isChatNearBottom() {
        if (!this.chatMessagesContainer) return true;
        const { scrollTop, scrollHeight, clientHeight } = this.chatMessagesContainer;
        return scrollHeight - (scrollTop + clientHeight) < 60;
    }

    scrollChatToBottom({ smooth = true } = {}) {
        if (!this.chatMessagesContainer) return;
        if (smooth) {
            this.chatMessagesContainer.scrollTo({ top: this.chatMessagesContainer.scrollHeight, behavior: 'smooth' });
        } else {
            this.chatMessagesContainer.scrollTop = this.chatMessagesContainer.scrollHeight;
        }
    }

    renderChatMessages(messages) {
        if (!this.chatMessagesContainer) return;
        const shouldStick = this.chatForceScrollNext || !this.chatAutoScrollLocked || this.isChatNearBottom();
        this.chatMessagesContainer.innerHTML = '';

        if (!Array.isArray(messages) || messages.length === 0) {
            const placeholder = this.chatActiveId ? 'No recent text messages yet.' : 'Pick a conversation to load the history.';
            this.showChatPlaceholder(placeholder);
            this.chatForceScrollNext = false;
            return;
        }

        const fragment = document.createDocumentFragment();
        messages.forEach(message => {
            const bubble = document.createElement('div');
            bubble.className = 'chat-message ' + (message.isOutbound ? 'outgoing' : 'incoming');

            const text = document.createElement('div');
            text.textContent = message.text;
            bubble.appendChild(text);

            const meta = document.createElement('div');
            meta.className = 'meta';

            if (!message.isOutbound) {
                const sender = document.createElement('span');
                sender.className = 'chat-sender';
                sender.textContent = message.senderName || 'Participant';
                meta.appendChild(sender);
            }

            const time = document.createElement('time');
            if (Number.isFinite(message.timestamp)) {
                const date = new Date(message.timestamp);
                time.dateTime = date.toISOString();
                time.textContent = date.toLocaleString();
            } else {
                time.textContent = 'Unknown time';
            }
            meta.appendChild(time);

            bubble.appendChild(meta);
            fragment.appendChild(bubble);
        });

        this.chatMessagesContainer.appendChild(fragment);
        if (shouldStick) {
            this.scrollChatToBottom({ smooth: !this.chatForceScrollNext });
        }
        this.chatForceScrollNext = false;
    }

    setChatMessagesLoading(isLoading) {
        if (!this.chatMessagesContainer) return;
        this.chatMessagesContainer.classList.toggle('is-loading', !!isLoading);
        this.chatMessagesContainer.setAttribute('aria-busy', String(!!isLoading));
    }

    async fetchChatMessages(chatId, { refreshOnly = false } = {}) {
        if (!chatId || !this.botIsRunning) return;
        if (this.chatLoadingMessages && !refreshOnly) {
            return;
        }
        this.chatLoadingMessages = true;
        if (!refreshOnly) {
            this.setChatMessagesLoading(true);
        }
        try {
            const response = await fetch(`/api/telegram/chats/${encodeURIComponent(chatId)}/messages?limit=80`, { cache: 'no-store' });
            const data = await response.json();
            if (!response.ok || !data.success) {
                throw new Error(data?.message || 'Failed to load chat messages');
            }
            const messages = Array.isArray(data.messages) ? data.messages : [];
            this.renderChatMessages(messages);
            if (this.chatLastUpdated) {
                this.chatLastUpdated.textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
            }
        } catch (error) {
            const message = error && error.message ? error.message : 'Failed to load chat messages';
            if (!refreshOnly) {
                this.showChatPlaceholder(message);
                this.log('❌ ' + message);
            }
        } finally {
            this.chatLoadingMessages = false;
            this.setChatMessagesLoading(false);
            this.updateChatStatusBadge();
            this.updateChatControlsState();
            this.updateChatDetails();
        }
    }

    onChatScrolled() {
        this.chatAutoScrollLocked = !this.isChatNearBottom();
    }

    async sendChatMessage() {
        if (!this.chatInput) return;
        const text = this.chatInput.value.trim();
        if (!text) {
            return;
        }
        if (!this.chatActiveId) {
            this.log('Select a chat before sending a message.');
            return;
        }
        if (!this.botIsRunning) {
            this.log('Start the bot before sending messages.');
            return;
        }
        if (this.chatSendingMessage) {
            return;
        }

        this.chatSendingMessage = true;
        this.updateChatControlsState();

        try {
            const response = await fetch(`/api/telegram/chats/${encodeURIComponent(this.chatActiveId)}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text })
            });
            const data = await response.json();
            if (!response.ok || !data.success) {
                throw new Error(data?.message || 'Failed to send message');
            }
            this.chatInput.value = '';
            this.chatForceScrollNext = true;
            await this.fetchChatMessages(this.chatActiveId);
            const active = this.chatList.find(chat => chat.id === this.chatActiveId);
            const label = active ? active.title : 'chat';
            this.log(`💬 Sent manual reply to ${label}.`);
            this.loadChats(false);
        } catch (error) {
            const message = error && error.message ? error.message : 'Failed to send message';
            this.log('❌ ' + message);
        } finally {
            this.chatSendingMessage = false;
            this.updateChatControlsState();
        }
    }

    handleBotStoppedChats() {
        this.chatList = [];
        this.chatActiveId = null;
        this.populateChatSelectPlaceholder('Start the bot to load chats');
        this.showChatPlaceholder('Start the bot to load chats.');
        if (this.chatLastUpdated) {
            this.chatLastUpdated.textContent = 'Last updated: —';
        }
        this.updateChatDetails();
    }

    setupMetricsDashboard() {
        this.initializeCharts();
        this.refreshMetrics();
        this.metricsInterval = setInterval(() => this.refreshMetrics(), 5000);
    }

    initializeCharts() {
        if (typeof Chart === 'undefined') {
            console.warn('Chart.js not loaded; skipping chart initialization');
            return;
        }
        const colors = this.getThemeColors();
        if (this.throughputCanvas && this.throughputCanvas.getContext) {
            const ctx = this.throughputCanvas.getContext('2d');
            if (ctx) {
                this.timelineChart = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: [],
                        datasets: [
                            {
                                label: 'Inbound',
                                data: [],
                                tension: 0.35,
                                fill: true,
                                borderWidth: 2,
                                borderColor: colors.inbound,
                                backgroundColor: withAlpha(colors.inbound, 0.25),
                                pointRadius: 0,
                            },
                            {
                                label: 'Outbound',
                                data: [],
                                tension: 0.35,
                                fill: true,
                                borderWidth: 2,
                                borderColor: colors.outbound,
                                backgroundColor: withAlpha(colors.outbound, 0.25),
                                pointRadius: 0,
                            },
                        ],
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        scales: {
                            x: {
                                ticks: { color: colors.text },
                                grid: { color: withAlpha(colors.border, 0.4) },
                            },
                            y: {
                                beginAtZero: true,
                                ticks: { color: colors.text },
                                grid: { color: withAlpha(colors.border, 0.4) },
                            },
                        },
                        plugins: {
                            legend: {
                                labels: { color: colors.text },
                            },
                        },
                    },
                });
            }
        }

        if (this.providerCanvas && this.providerCanvas.getContext) {
            const ctx = this.providerCanvas.getContext('2d');
            if (ctx) {
                this.providerChart = new Chart(ctx, {
                    type: 'doughnut',
                    data: {
                        labels: [],
                        datasets: [
                            {
                                data: [],
                                backgroundColor: [],
                                borderColor: [],
                                borderWidth: 1,
                            },
                        ],
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                            legend: {
                                position: 'bottom',
                                labels: { color: colors.text },
                            },
                        },
                    },
                });
            }
        }
    }

    async refreshMetrics() {
        try {
            const response = await fetch('/api/metrics', { cache: 'no-store' });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const data = await response.json();
            this.updateMetricsUI(data);
            this.lastMetricsError = null;
        } catch (error) {
            if (this.lastMetricsError !== error?.message) {
                console.warn('Failed to refresh metrics:', error);
            }
            this.lastMetricsError = error?.message || 'error';
            if (this.metricsTimestamp) {
                this.metricsTimestamp.textContent = 'Last updated: error';
            }
        }
    }

    updateMetricsUI(snapshot) {
        if (!snapshot || typeof snapshot !== 'object') return;
        if (this.metricsTimestamp) {
            this.metricsTimestamp.textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
        }

        this.updateSummaryCards(snapshot);

        if (this.metricCards.uptime) {
            this.metricCards.uptime.textContent = formatDuration(snapshot.uptimeMs);
        }
        if (this.metricCards.contacts) {
            this.metricCards.contacts.textContent = this.numberFormatter.format(snapshot?.totals?.uniqueContacts || 0);
        }
        if (this.metricCards.inbound) {
            this.metricCards.inbound.textContent = this.numberFormatter.format(snapshot?.totals?.inbound || 0);
        }
        if (this.metricCards.outbound) {
            this.metricCards.outbound.textContent = this.numberFormatter.format(snapshot?.totals?.outbound || 0);
        }
        if (this.metricCards.response) {
            const avg = snapshot?.responseTime?.averageMs;
            this.metricCards.response.textContent = Number.isFinite(avg) ? `${Math.round(avg)} ms` : '—';
        }

        this.updateTimelineChart(snapshot.timeline || []);
        this.updateProviderChart(snapshot.providers || []);
        this.updateLeaderboard(snapshot.contacts || []);
    }

    updateSummaryCards(snapshot) {
        if (!this.summaryCards) return;
        const totals = snapshot?.totals || {};
        if (this.summaryCards.uptime) {
            this.summaryCards.uptime.textContent = formatDuration(snapshot.uptimeMs);
        }
        if (this.summaryCards.contacts) {
            this.summaryCards.contacts.textContent = this.numberFormatter.format(totals.uniqueContacts || 0);
        }
        if (this.summaryCards.inbound) {
            this.summaryCards.inbound.textContent = this.numberFormatter.format(totals.inbound || 0);
        }
        if (this.summaryCards.outbound) {
            this.summaryCards.outbound.textContent = this.numberFormatter.format(totals.outbound || 0);
        }
        if (this.summaryCards.response) {
            const avg = snapshot?.responseTime?.averageMs;
            this.summaryCards.response.textContent = Number.isFinite(avg) ? `${Math.round(avg)} ms` : '—';
        }
    }

    updateTimelineChart(buckets) {
        if (!this.timelineChart) return;
        if (!Array.isArray(buckets) || buckets.length === 0) {
            this.timelineChart.data.labels = [''];
            this.timelineChart.data.datasets[0].data = [0];
            this.timelineChart.data.datasets[1].data = [0];
        } else {
            const labels = buckets.map(bucket => new Date(bucket.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
            const inbound = buckets.map(bucket => bucket.inbound || 0);
            const outbound = buckets.map(bucket => bucket.outbound || 0);
            this.timelineChart.data.labels = labels;
            this.timelineChart.data.datasets[0].data = inbound;
            this.timelineChart.data.datasets[1].data = outbound;
        }
        this.timelineChart.update('none');
    }

    updateProviderChart(providers) {
        if (!this.providerChart) return;
        const colors = this.getThemeColors();
        let labels = [];
        let data = [];
        let backgrounds = [];
        if (!Array.isArray(providers) || providers.length === 0) {
            labels = ['No data'];
            data = [1];
            const fallbackColor = withAlpha(colors.text, 0.15);
            backgrounds = [fallbackColor];
        } else {
            labels = providers.map(p => `${p.provider} (${p.requests - p.failures}/${p.requests})`);
            data = providers.map(p => p.requests || 0);
            backgrounds = providers.map((_, index) => this.providerPalette[index % this.providerPalette.length]);
        }
        const dataset = this.providerChart.data.datasets[0];
        this.providerChart.data.labels = labels;
        dataset.data = data;
        dataset.backgroundColor = backgrounds;
        dataset.borderColor = backgrounds.map(color => withAlpha(color, 0.9));
        this.providerChart.update('none');
    }

    updateLeaderboard(contacts) {
        if (!this.leaderboardBody) return;
        this.leaderboardBody.innerHTML = '';
        if (!Array.isArray(contacts) || contacts.length === 0) {
            const row = document.createElement('tr');
            const cell = document.createElement('td');
            cell.colSpan = 4;
            cell.textContent = 'No data yet';
            row.appendChild(cell);
            this.leaderboardBody.appendChild(row);
            return;
        }

        const topContacts = contacts.slice(0, 10);
        topContacts.forEach(contact => {
            const row = document.createElement('tr');
            const idCell = document.createElement('td');
            const inboundCell = document.createElement('td');
            const outboundCell = document.createElement('td');
            const lastSeenCell = document.createElement('td');

            const contactId = String(contact.contactId || 'unknown');
            idCell.textContent = contactId.length > 20 ? contactId.slice(0, 17) + '…' : contactId;
            idCell.title = contactId;
            inboundCell.textContent = this.numberFormatter.format(contact.inbound || 0);
            outboundCell.textContent = this.numberFormatter.format(contact.outbound || 0);
            lastSeenCell.textContent = formatRelativeTime(contact.lastSeenAt);
            if (Number.isFinite(contact.lastSeenAt)) {
                lastSeenCell.title = new Date(contact.lastSeenAt).toLocaleString();
            }

            row.appendChild(idCell);
            row.appendChild(inboundCell);
            row.appendChild(outboundCell);
            row.appendChild(lastSeenCell);
            this.leaderboardBody.appendChild(row);
        });
    }

    handleTabActivated(tabId) {
        if (tabId === 'metrics') {
            this.refreshMetrics();
            window.requestAnimationFrame(() => this.resizeCharts());
        }
        if (tabId === 'activity' && this.logDiv) {
            this.logDiv.scrollTop = this.logDiv.scrollHeight;
        }
        if (tabId === 'chats') {
            this.chatTabActive = true;
            if (this.botIsRunning) {
                this.loadChats(false);
                if (this.chatActiveId) {
                    this.chatForceScrollNext = true;
                    this.fetchChatMessages(this.chatActiveId);
                }
            }
            this.startChatPolling();
        } else if (this.chatTabActive) {
            this.chatTabActive = false;
            this.stopChatPolling();
        }
    }

    resizeCharts() {
        if (this.timelineChart && typeof this.timelineChart.resize === 'function') {
            try {
                this.timelineChart.resize();
            } catch (error) {
                console.warn('Timeline chart resize failed:', error);
            }
        }
        if (this.providerChart && typeof this.providerChart.resize === 'function') {
            try {
                this.providerChart.resize();
            } catch (error) {
                console.warn('Provider chart resize failed:', error);
            }
        }
    }

    getThemeColors() {
        const styles = getComputedStyle(document.documentElement);
        const text = styles.getPropertyValue('--text').trim() || '#e5e7eb';
        const border = styles.getPropertyValue('--log-border').trim() || 'rgba(148, 163, 184, 0.4)';
        const inbound = styles.getPropertyValue('--button-start-bg').trim() || '#1f7a31';
        const outbound = styles.getPropertyValue('--button-stop-bg').trim() || '#a72a39';
        return { text, border, inbound, outbound };
    }

    refreshChartTheme() {
        const colors = this.getThemeColors();
        if (this.timelineChart) {
            const inboundDataset = this.timelineChart.data.datasets[0];
            const outboundDataset = this.timelineChart.data.datasets[1];
            inboundDataset.borderColor = colors.inbound;
            inboundDataset.backgroundColor = withAlpha(colors.inbound, 0.25);
            outboundDataset.borderColor = colors.outbound;
            outboundDataset.backgroundColor = withAlpha(colors.outbound, 0.25);

            if (this.timelineChart.options?.scales?.x) {
                this.timelineChart.options.scales.x.ticks = this.timelineChart.options.scales.x.ticks || {};
                this.timelineChart.options.scales.x.ticks.color = colors.text;
                this.timelineChart.options.scales.x.grid = this.timelineChart.options.scales.x.grid || {};
                this.timelineChart.options.scales.x.grid.color = withAlpha(colors.border, 0.4);
            }
            if (this.timelineChart.options?.scales?.y) {
                this.timelineChart.options.scales.y.ticks = this.timelineChart.options.scales.y.ticks || {};
                this.timelineChart.options.scales.y.ticks.color = colors.text;
                this.timelineChart.options.scales.y.grid = this.timelineChart.options.scales.y.grid || {};
                this.timelineChart.options.scales.y.grid.color = withAlpha(colors.border, 0.4);
            }
            if (this.timelineChart.options?.plugins?.legend?.labels) {
                this.timelineChart.options.plugins.legend.labels.color = colors.text;
            }
            this.timelineChart.update('none');
        }
        if (this.providerChart) {
            if (this.providerChart.options?.plugins?.legend?.labels) {
                this.providerChart.options.plugins.legend.labels.color = colors.text;
            }
            this.providerChart.update('none');
        }
    }
}

class TabController {
    constructor(controller) {
        this.controller = controller;
        this.storageKey = 'dashboard.activeTab';
        this.tabs = [];
        this.activeTab = null;
        const buttons = Array.from(document.querySelectorAll('.tab-button[role="tab"]'));
        buttons.forEach((button, index) => {
            const slug = button.dataset.tab;
            const panelId = button.getAttribute('aria-controls');
            const panel = panelId ? document.getElementById(panelId) : null;
            if (!slug || !panel) {
                return;
            }
            this.tabs.push({ slug, button, panel, index });
            button.addEventListener('click', () => this.activate(slug));
            button.addEventListener('keydown', (event) => this.onKeydown(event, slug));
        });

        const saved = this.getSavedTab();
        if (saved && this.tabs.some(tab => tab.slug === saved)) {
            this.activate(saved, { focusButton: false, skipStore: true });
        } else if (this.tabs.length > 0) {
            this.activate(this.tabs[0].slug, { focusButton: false, skipStore: true });
        }
    }

    activate(slug, { focusButton = true, skipStore = false } = {}) {
        if (this.activeTab === slug) return;
        this.activeTab = slug;
        this.tabs.forEach(({ slug: tabSlug, button, panel }) => {
            const isActive = tabSlug === slug;
            button.setAttribute('aria-selected', String(isActive));
            button.tabIndex = isActive ? 0 : -1;
            if (isActive && focusButton) {
                button.focus();
            }
            if (isActive) {
                panel.removeAttribute('hidden');
                panel.setAttribute('aria-hidden', 'false');
            } else {
                panel.setAttribute('hidden', '');
                panel.setAttribute('aria-hidden', 'true');
            }
        });

        if (!skipStore) {
            try {
                localStorage.setItem(this.storageKey, slug);
            } catch (error) {
                console.warn('Unable to persist active tab:', error);
            }
        }

        if (this.controller && typeof this.controller.handleTabActivated === 'function') {
            this.controller.handleTabActivated(slug);
        }
    }

    onKeydown(event, slug) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
            return;
        }
        event.preventDefault();
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        const currentIndex = this.tabs.findIndex(tab => tab.slug === slug);
        if (currentIndex === -1) return;
        const total = this.tabs.length;
        const nextIndex = (currentIndex + direction + total) % total;
        const nextTab = this.tabs[nextIndex];
        if (nextTab) {
            this.activate(nextTab.slug, { focusButton: true });
        }
    }

    getSavedTab() {
        try {
            return localStorage.getItem(this.storageKey);
        } catch (error) {
            console.warn('Unable to read saved tab preference:', error);
            return null;
        }
    }
}

// Initialize the controller when the page loads
document.addEventListener('DOMContentLoaded', () => {
    const toggle = document.getElementById('themeToggle');
    const label = document.getElementById('themeLabel');
    const saved = localStorage.getItem('theme');
    const theme = (saved === 'light' || saved === 'dark') ? saved : 'dark';

    applyTheme(theme);

    const controller = new BotController();
    new TabController(controller);

    if (toggle) {
        toggle.checked = theme === 'dark';
        updateThemeLabel(label, theme);
        toggle.addEventListener('change', () => {
            const newTheme = toggle.checked ? 'dark' : 'light';
            applyTheme(newTheme);
            updateThemeLabel(label, newTheme);
            try { localStorage.setItem('theme', newTheme); } catch (e) { }
            controller.refreshChartTheme();
            controller.resizeCharts();
        });
    }

    controller.refreshChartTheme();
});


