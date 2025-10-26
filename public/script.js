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

function formatPersonaName(personaId) {
    if (!personaId) return 'Unknown';
    const trimmed = String(personaId);
    const withoutExt = trimmed.replace(/\.[^/.]+$/, '');
    const parts = withoutExt.split(/[-_\s]+/).filter(Boolean);
    if (parts.length === 0) return trimmed;
    return parts.map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
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
        this.openrouterKeyRow = document.getElementById('openrouterKeyRow');
        this.openrouterApiKeyInput = document.getElementById('openrouterApiKeyInput');
        this.openrouterApiKeySave = document.getElementById('openrouterApiKeySave');
        this.openrouterApiKeyClear = document.getElementById('openrouterApiKeyClear');
        this.openrouterKeyStatus = document.getElementById('openrouterKeyStatus');
        // Supervisor configuration elements
        this.supervisorModeRadios = document.querySelectorAll('input[name="supervisorMode"]');
        this.supervisorContactInput = document.getElementById('supervisorContactInput');
        this.wakeUpDelayMin = document.getElementById('wakeUpDelayMin');
        this.wakeUpDelayMax = document.getElementById('wakeUpDelayMax');
        this.alwaysDelayMin = document.getElementById('alwaysDelayMin');
        this.alwaysDelayMax = document.getElementById('alwaysDelayMax');
        this.sleepThresholdInput = document.getElementById('sleepThresholdInput');
        this.wakeUpDelayGroup = document.getElementById('wakeUpDelayGroup');
        this.alwaysDelayGroup = document.getElementById('alwaysDelayGroup');
        this.sleepThresholdGroup = document.getElementById('sleepThresholdGroup');
        this.supervisorSaveBtn = document.getElementById('supervisorSaveBtn');
        this.supervisorStatus = document.getElementById('supervisorStatus');
        this._supervisorStatusTimer = null;
        // Message delays configuration elements
        this.readingDelayMin = document.getElementById('readingDelayMin');
        this.readingDelayMax = document.getElementById('readingDelayMax');
        this.typingDurationMin = document.getElementById('typingDurationMin');
        this.typingDurationMax = document.getElementById('typingDurationMax');
        this.typingKeepaliveInput = document.getElementById('typingKeepaliveInput');
        this.messageDelaysSaveBtn = document.getElementById('messageDelaysSaveBtn');
        this.messageDelaysStatus = document.getElementById('messageDelaysStatus');
        this._messageDelaysStatusTimer = null;
        this.metricsTimestamp = document.getElementById('metricsTimestamp');
        this.metricCards = {
            uptime: document.getElementById('metricUptime'),
            contacts: document.getElementById('metricContacts'),
            inbound: document.getElementById('metricInbound'),
            outbound: document.getElementById('metricOutbound'),
            response: document.getElementById('metricResponse'),
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
        this.botIsRunning = false;
        this.accountList = document.getElementById('accountList');
        this.accountForm = document.getElementById('accountForm');
        this.accountFormTitle = document.getElementById('accountFormTitle');
        this.accountNotice = document.getElementById('accountNotice');
        this.accountIdInput = document.getElementById('accountId');

        if (this.openrouterApiKeySave) {
            this.openrouterApiKeySave.addEventListener('click', () => this.saveOpenrouterKey());
        }
        // Key is visible by default; no reveal/hide toggle
        if (this.openrouterApiKeyClear) {
            this.openrouterApiKeyClear.addEventListener('click', () => {
                if (this.openrouterApiKeyInput) this.openrouterApiKeyInput.value = '';
                this.saveOpenrouterKey();
            });
        }
        // Supervisor configuration event listeners
        if (this.supervisorModeRadios && this.supervisorModeRadios.length > 0) {
            this.supervisorModeRadios.forEach(radio => {
                radio.addEventListener('change', () => this.updateSupervisorUIState());
            });
        }
        if (this.supervisorSaveBtn) {
            this.supervisorSaveBtn.addEventListener('click', () => this.saveSupervisorConfig());
        }
        // Message delays configuration event listener
        if (this.messageDelaysSaveBtn) {
            this.messageDelaysSaveBtn.addEventListener('click', () => this.saveMessageDelaysConfig());
        }
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
        this._escalationStatusTimer = null;
        this.chatListContainer = document.getElementById('chatList');
        this.chatEmptyState = document.getElementById('chatEmptyState');
        this.chatRefreshBtn = document.getElementById('chatRefreshBtn');
        this.chatSpeedToggle = document.getElementById('chatSpeedToggle');
        this.chatSpeedButtons = this.chatSpeedToggle ? Array.from(this.chatSpeedToggle.querySelectorAll('[data-speed]')) : [];
        this.chatSearchInput = document.getElementById('chatSearchInput');
        this.chatStatusBanner = document.getElementById('chatStatus');
        this.chatTitleEl = document.getElementById('chatActiveTitle');
        this.chatMetaEl = document.getElementById('chatActiveMeta');
        this.chatMessagesEl = document.getElementById('chatMessages');
        this.chatPersonaSelect = document.getElementById('chatPersonaSelect');
        this.chatPersonaResetBtn = document.getElementById('chatPersonaResetBtn');
        this.chatComposer = document.getElementById('chatComposer');
        this.chatMessageInput = document.getElementById('chatMessageInput');
        this.chatSendBtn = document.getElementById('chatSendBtn');
        this.chatBlendBtn = document.getElementById('chatBlendBtn');
        this.chatPanel = document.querySelector('.chat-panel');
        this.chatSidebar = document.querySelector('.chat-sidebar');
        this.chatToggleSidebarBtn = document.getElementById('chatToggleSidebar');
        this.chatCloseSidebarBtn = document.getElementById('chatCloseSidebar');
        this.chatListData = [];
        this.filteredChats = [];
        this.activeChatId = null;
        this.chatPollInterval = null;
        this.chatPollTick = 0;
        this.chatLoading = false;
        this.loadingChats = false;
        this.chatSending = false;
        this.chatBlending = false;
        this.chatAutoScroll = true;
        this.chatSearchTerm = '';
        this._chatStatusTimer = null;
        this.chatRenderCache = new Map();
        this.currentTab = 'configuration';
        this.chatRefreshRates = {
            turtle: { interval: 15000, listEvery: 2 },
            normal: { interval: 5000, listEvery: 3 },
            rabbit: { interval: 2000, listEvery: 5 },
        };
        this.chatRefreshSpeed = this.loadChatRefreshSpeed();
        this.availablePersonas = [];
        this.globalPersonaId = null;
        this.activeChatPersonaId = null;
        this.activeChatUsesDefaultPersona = null;
        this.activeChatPersonaUpdatedAt = null;
        this._suppressChatPersonaChange = false;
        this.chatPersonaBusy = false;

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
        if (this.chatRefreshBtn) {
            this.chatRefreshBtn.addEventListener('click', () => this.loadChats({ silent: false, force: true }));
        }
        if (this.chatSpeedButtons.length > 0) {
            this.chatSpeedButtons.forEach(button => {
                button.addEventListener('click', () => {
                    const speed = button.dataset.speed || 'normal';
                    this.setChatRefreshSpeed(speed);
                });
            });
        }
        this.updateChatSpeedToggleUI();
        if (this.chatSearchInput) {
            this.chatSearchInput.addEventListener('input', () => this.handleChatSearch());
        }
        if (this.chatComposer) {
            this.chatComposer.addEventListener('submit', (event) => {
                event.preventDefault();
                this.submitChatMessage();
            });
        }
        if (this.chatBlendBtn) {
            this.chatBlendBtn.addEventListener('click', () => this.sendBlendReply());
        }
        if (this.chatPersonaSelect) {
            this.chatPersonaSelect.addEventListener('change', () => this.handleActiveChatPersonaChange());
        }
        if (this.chatPersonaResetBtn) {
            this.chatPersonaResetBtn.addEventListener('click', () => this.resetActiveChatPersona());
        }
        if (this.chatToggleSidebarBtn) {
            this.chatToggleSidebarBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleMobileSidebar();
            });
        }
        if (this.chatCloseSidebarBtn) {
            this.chatCloseSidebarBtn.addEventListener('click', () => this.closeMobileSidebar());
        }
        if (this.chatMessageInput) {
            this.chatMessageInput.addEventListener('input', () => this.updateChatComposerState());
            // Send on Enter, newline on Shift+Enter
            this.chatMessageInput.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    if (!this.chatSendBtn || this.chatSendBtn.disabled) return;
                    this.submitChatMessage();
                }
            });
        }
        if (this.chatMessagesEl) {
            this.chatMessagesEl.addEventListener('scroll', () => this.handleChatScroll());
        }
        if (this.chatPanel) {
            // Close when tapping the dimmed overlay (outside the sidebar),
            // but ignore clicks on the toggle button itself.
            this.chatPanel.addEventListener('click', (e) => {
                if (!this.chatPanel.classList.contains('mobile-sidebar-open')) return;
                const sidebar = this.chatSidebar || document.querySelector('.chat-sidebar');
                if (!sidebar) return;
                const clickedToggle = this.chatToggleSidebarBtn && (this.chatToggleSidebarBtn === e.target || this.chatToggleSidebarBtn.contains(e.target));
                if (clickedToggle) return;
                if (!sidebar.contains(e.target)) {
                    this.closeMobileSidebar();
                }
            });
        }
        // Close mobile sidebar on Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.closeMobileSidebar();
        });
        // Ensure sidebar closes when resizing to desktop
        window.addEventListener('resize', () => {
            if (!this.isMobile()) this.closeMobileSidebar();
        });

        this.updateChatStatus('Select a chat to preview live messages.', 'info');
        this.updateChatComposerState();

        // Check initial status
        this.checkStatus();

        // Load available personalities
        this.loadPersonalities();

        // Load LLM configuration
        this.loadLLMConfig();

        // Load supervisor configuration
        this.loadSupervisorConfig();

        // Load message delays configuration
        this.loadMessageDelaysConfig();

        // Load Telegram accounts
        this.loadAccounts();

        // Check status every 5 seconds
        setInterval(() => this.checkStatus(), 5000);

        // Initialize charts if Chart.js is available; otherwise continue without graphs
        try {
            if (typeof window !== 'undefined' && window.Chart) {
                this.setupMetricsDashboard();
            } else {
                this.log('Charts not available (skipping graph init)');
            }
        } catch (e) {
            try { this.log('Charts init failed, continuing without graphs'); } catch {}
        }
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
        this.updateChatComposerState();
        if (this.botIsRunning && !previouslyRunning) {
            if (this.currentTab === 'chats') {
                this.startChatPolling();
            }
        } else if (!this.botIsRunning && previouslyRunning) {
            this.stopChatPolling();
            if (this.chatStatusBanner) {
                this.updateChatStatus('Bot stopped. Start it to continue chatting.', 'warning');
            }
        }
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
                this.availablePersonas = data.available.slice();
                this.globalPersonaId = typeof data.current === 'string' ? data.current : null;
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
                this.refreshChatPersonaOptions();
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
            if (this.openrouterKeyStatus) {
                this.openrouterKeyStatus.textContent = data.hasOpenrouterKey ? 'Key set' : 'No key set';
            }
            if (data.provider === 'openrouter' && !data.hasOpenrouterKey) {
                this.log('âš  OpenRouter selected but no API key set in settings');
            }

            if (data.provider === 'openrouter' && !data.hasOpenrouterKey) {
                this.log('⚠️ OpenRouter selected but no OPENROUTER_API_KEY found in server .env');
            }

            this.log('LLM config loaded');
        } catch (error) {
            this.log('❌ Error loading LLM config: ' + error.message);
        }
    }

    async loadSupervisorConfig() {
        if (this._supervisorStatusTimer) {
            clearTimeout(this._supervisorStatusTimer);
            this._supervisorStatusTimer = null;
        }
        try {
            const response = await fetch('/api/config/supervisor');
            if (!response.ok) {
                throw new Error('HTTP ' + response.status);
            }
            const data = await response.json();
            
            // Set mode
            const mode = data.mode || 'wake-up';
            if (this.supervisorModeRadios && this.supervisorModeRadios.length > 0) {
                this.supervisorModeRadios.forEach(radio => {
                    radio.checked = radio.value === mode;
                });
            }
            
            // Set contact
            if (this.supervisorContactInput) {
                this.supervisorContactInput.value = data.contact || '';
            }
            
            // Set wake-up delays (convert ms to seconds)
            if (this.wakeUpDelayMin && data.wakeUpDelayMs && data.wakeUpDelayMs.min) {
                this.wakeUpDelayMin.value = Math.round(data.wakeUpDelayMs.min / 1000);
            }
            if (this.wakeUpDelayMax && data.wakeUpDelayMs && data.wakeUpDelayMs.max) {
                this.wakeUpDelayMax.value = Math.round(data.wakeUpDelayMs.max / 1000);
            }
            
            // Set always delays (convert ms to seconds)
            if (this.alwaysDelayMin && data.alwaysFallbackDelayMs && data.alwaysFallbackDelayMs.min) {
                this.alwaysDelayMin.value = Math.round(data.alwaysFallbackDelayMs.min / 1000);
            }
            if (this.alwaysDelayMax && data.alwaysFallbackDelayMs && data.alwaysFallbackDelayMs.max) {
                this.alwaysDelayMax.value = Math.round(data.alwaysFallbackDelayMs.max / 1000);
            }
            
            // Set sleep threshold (convert ms to seconds)
            if (this.sleepThresholdInput && data.sleepThresholdMs) {
                this.sleepThresholdInput.value = (data.sleepThresholdMs / 1000).toFixed(1);
            }
            
            // Update UI state based on mode
            this.updateSupervisorUIState();
            
            if (this.supervisorStatus) {
                this.supervisorStatus.textContent = '';
                delete this.supervisorStatus.dataset.variant;
            }
            
            this.log('Supervisor configuration loaded');
        } catch (error) {
            if (this.supervisorStatus) {
                this.supervisorStatus.textContent = 'Failed to load configuration';
                this.supervisorStatus.dataset.variant = 'error';
            }
            this.log('❌ Error loading supervisor config: ' + error.message);
            this._supervisorStatusTimer = setTimeout(() => {
                if (this.supervisorStatus) {
                    this.supervisorStatus.textContent = '';
                    delete this.supervisorStatus.dataset.variant;
                }
                this._supervisorStatusTimer = null;
            }, 4000);
        }
    }

    updateSupervisorUIState() {
        if (!this.supervisorModeRadios || this.supervisorModeRadios.length === 0) return;
        
        // Get selected mode
        let selectedMode = 'wake-up';
        this.supervisorModeRadios.forEach(radio => {
            if (radio.checked) {
                selectedMode = radio.value;
            }
        });
        
        // Update contact input state
        if (this.supervisorContactInput) {
            const isDisabled = selectedMode === 'disabled';
            this.supervisorContactInput.disabled = isDisabled;
            if (isDisabled) {
                this.supervisorContactInput.style.opacity = '0.5';
            } else {
                this.supervisorContactInput.style.opacity = '1';
            }
        }
        
        // Show/hide delay groups based on mode
        if (this.wakeUpDelayGroup) {
            if (selectedMode === 'wake-up') {
                this.wakeUpDelayGroup.style.display = '';
                this.wakeUpDelayGroup.classList.remove('disabled');
            } else {
                this.wakeUpDelayGroup.style.display = 'none';
            }
        }
        
        if (this.alwaysDelayGroup) {
            if (selectedMode === 'always') {
                this.alwaysDelayGroup.style.display = '';
                this.alwaysDelayGroup.classList.remove('disabled');
            } else {
                this.alwaysDelayGroup.style.display = 'none';
            }
        }
        
        if (this.sleepThresholdGroup) {
            if (selectedMode === 'wake-up') {
                this.sleepThresholdGroup.style.display = '';
                this.sleepThresholdGroup.classList.remove('disabled');
            } else {
                this.sleepThresholdGroup.style.display = 'none';
            }
        }
        
        // Disable all delay inputs when mode is disabled
        const allDelayInputs = [
            this.wakeUpDelayMin, this.wakeUpDelayMax,
            this.alwaysDelayMin, this.alwaysDelayMax,
            this.sleepThresholdInput
        ];
        allDelayInputs.forEach(input => {
            if (input) {
                input.disabled = selectedMode === 'disabled';
            }
        });
    }

    async saveSupervisorConfig() {
        if (!this.supervisorModeRadios || this.supervisorModeRadios.length === 0) return;
        
        // Get selected mode
        let mode = 'wake-up';
        this.supervisorModeRadios.forEach(radio => {
            if (radio.checked) {
                mode = radio.value;
            }
        });
        
        // Get contact
        const contact = this.supervisorContactInput ? this.supervisorContactInput.value.trim() : '';
        
        // Validate contact for non-disabled modes
        if (mode !== 'disabled' && !contact) {
            if (this.supervisorStatus) {
                this.supervisorStatus.textContent = 'Contact is required for non-disabled modes';
                this.supervisorStatus.dataset.variant = 'error';
            }
            this._supervisorStatusTimer = setTimeout(() => {
                if (this.supervisorStatus) {
                    this.supervisorStatus.textContent = '';
                    delete this.supervisorStatus.dataset.variant;
                }
                this._supervisorStatusTimer = null;
            }, 4000);
            return;
        }
        
        // Build payload
        const payload = { mode, contact };
        
        // Add wake-up delays (convert seconds to ms)
        if (this.wakeUpDelayMin && this.wakeUpDelayMax) {
            const min = parseFloat(this.wakeUpDelayMin.value) * 1000;
            const max = parseFloat(this.wakeUpDelayMax.value) * 1000;
            if (min > max) {
                if (this.supervisorStatus) {
                    this.supervisorStatus.textContent = 'Wake-up min delay must be ≤ max delay';
                    this.supervisorStatus.dataset.variant = 'error';
                }
                this._supervisorStatusTimer = setTimeout(() => {
                    if (this.supervisorStatus) {
                        this.supervisorStatus.textContent = '';
                        delete this.supervisorStatus.dataset.variant;
                    }
                    this._supervisorStatusTimer = null;
                }, 4000);
                return;
            }
            payload.wakeUpDelayMs = { min, max };
        }
        
        // Add always delays (convert seconds to ms)
        if (this.alwaysDelayMin && this.alwaysDelayMax) {
            const min = parseFloat(this.alwaysDelayMin.value) * 1000;
            const max = parseFloat(this.alwaysDelayMax.value) * 1000;
            if (min > max) {
                if (this.supervisorStatus) {
                    this.supervisorStatus.textContent = 'Always min delay must be ≤ max delay';
                    this.supervisorStatus.dataset.variant = 'error';
                }
                this._supervisorStatusTimer = setTimeout(() => {
                    if (this.supervisorStatus) {
                        this.supervisorStatus.textContent = '';
                        delete this.supervisorStatus.dataset.variant;
                    }
                    this._supervisorStatusTimer = null;
                }, 4000);
                return;
            }
            payload.alwaysFallbackDelayMs = { min, max };
        }
        
        // Add sleep threshold (convert seconds to ms)
        if (this.sleepThresholdInput) {
            payload.sleepThresholdMs = parseFloat(this.sleepThresholdInput.value) * 1000;
        }
        
        // Show saving status
        if (this.supervisorStatus) {
            this.supervisorStatus.textContent = 'Saving...';
            delete this.supervisorStatus.dataset.variant;
        }
        if (this._supervisorStatusTimer) {
            clearTimeout(this._supervisorStatusTimer);
            this._supervisorStatusTimer = null;
        }
        
        // Disable save button
        if (this.supervisorSaveBtn) {
            this.supervisorSaveBtn.disabled = true;
        }
        
        try {
            const response = await fetch('/api/config/supervisor', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await response.json();
            if (!response.ok || (data && data.success === false)) {
                throw new Error((data && data.message) || ('HTTP ' + response.status));
            }
            
            if (this.supervisorStatus) {
                this.supervisorStatus.textContent = 'Configuration saved successfully';
                this.supervisorStatus.dataset.variant = 'success';
            }
            
            const modeLabel = mode === 'wake-up' ? 'Wake-Up' : mode === 'always' ? 'Always' : 'Disabled';
            this.log(`✅ Supervisor configuration saved (Mode: ${modeLabel})`);
            
            // Reload to ensure UI is in sync (but preserve the success message)
            const successMessage = this.supervisorStatus ? this.supervisorStatus.textContent : '';
            await this.loadSupervisorConfig();
            if (this.supervisorStatus && successMessage) {
                this.supervisorStatus.textContent = successMessage;
                this.supervisorStatus.dataset.variant = 'success';
            }
        } catch (error) {
            if (this.supervisorStatus) {
                this.supervisorStatus.textContent = 'Failed to save: ' + error.message;
                this.supervisorStatus.dataset.variant = 'error';
            }
            this.log('❌ Error saving supervisor config: ' + error.message);
        } finally {
            if (this.supervisorSaveBtn) {
                this.supervisorSaveBtn.disabled = false;
            }
            this._supervisorStatusTimer = setTimeout(() => {
                if (this.supervisorStatus) {
                    this.supervisorStatus.textContent = '';
                    delete this.supervisorStatus.dataset.variant;
                }
                this._supervisorStatusTimer = null;
            }, 3000);
        }
    }

    async loadMessageDelaysConfig() {
        if (this._messageDelaysStatusTimer) {
            clearTimeout(this._messageDelaysStatusTimer);
            this._messageDelaysStatusTimer = null;
        }
        try {
            const response = await fetch('/api/config/message-delays');
            if (!response.ok) {
                throw new Error('HTTP ' + response.status);
            }
            const data = await response.json();
            
            // Set reading delay (convert ms to seconds)
            if (this.readingDelayMin && data.waitBeforeTypingMs && data.waitBeforeTypingMs.min) {
                this.readingDelayMin.value = Math.round(data.waitBeforeTypingMs.min / 1000);
            }
            if (this.readingDelayMax && data.waitBeforeTypingMs && data.waitBeforeTypingMs.max) {
                this.readingDelayMax.value = Math.round(data.waitBeforeTypingMs.max / 1000);
            }
            
            // Set typing duration (convert ms to seconds)
            if (this.typingDurationMin && data.typingDurationMs && data.typingDurationMs.min) {
                this.typingDurationMin.value = Math.round(data.typingDurationMs.min / 1000);
            }
            if (this.typingDurationMax && data.typingDurationMs && data.typingDurationMs.max) {
                this.typingDurationMax.value = Math.round(data.typingDurationMs.max / 1000);
            }
            
            // Set typing keepalive (convert ms to seconds)
            if (this.typingKeepaliveInput && data.typingKeepaliveMs) {
                this.typingKeepaliveInput.value = (data.typingKeepaliveMs / 1000).toFixed(1);
            }
            
            if (this.messageDelaysStatus) {
                this.messageDelaysStatus.textContent = '';
                delete this.messageDelaysStatus.dataset.variant;
            }
            
            this.log('Message delays configuration loaded');
        } catch (error) {
            if (this.messageDelaysStatus) {
                this.messageDelaysStatus.textContent = 'Failed to load configuration';
                this.messageDelaysStatus.dataset.variant = 'error';
            }
            this.log('❌ Error loading message delays config: ' + error.message);
            this._messageDelaysStatusTimer = setTimeout(() => {
                if (this.messageDelaysStatus) {
                    this.messageDelaysStatus.textContent = '';
                    delete this.messageDelaysStatus.dataset.variant;
                }
                this._messageDelaysStatusTimer = null;
            }, 3000);
        }
    }

    async saveMessageDelaysConfig() {
        // Validate reading delay
        if (this.readingDelayMin && this.readingDelayMax) {
            const min = parseFloat(this.readingDelayMin.value);
            const max = parseFloat(this.readingDelayMax.value);
            if (min > max) {
                if (this.messageDelaysStatus) {
                    this.messageDelaysStatus.textContent = 'Reading delay min must be ≤ max';
                    this.messageDelaysStatus.dataset.variant = 'error';
                }
                this._messageDelaysStatusTimer = setTimeout(() => {
                    if (this.messageDelaysStatus) {
                        this.messageDelaysStatus.textContent = '';
                        delete this.messageDelaysStatus.dataset.variant;
                    }
                    this._messageDelaysStatusTimer = null;
                }, 3000);
                return;
            }
        }
        
        // Validate typing duration
        if (this.typingDurationMin && this.typingDurationMax) {
            const min = parseFloat(this.typingDurationMin.value);
            const max = parseFloat(this.typingDurationMax.value);
            if (min > max) {
                if (this.messageDelaysStatus) {
                    this.messageDelaysStatus.textContent = 'Typing duration min must be ≤ max';
                    this.messageDelaysStatus.dataset.variant = 'error';
                }
                this._messageDelaysStatusTimer = setTimeout(() => {
                    if (this.messageDelaysStatus) {
                        this.messageDelaysStatus.textContent = '';
                        delete this.messageDelaysStatus.dataset.variant;
                    }
                    this._messageDelaysStatusTimer = null;
                }, 3000);
                return;
            }
        }
        
        // Validate typing keepalive
        if (this.typingKeepaliveInput) {
            const keepalive = parseFloat(this.typingKeepaliveInput.value);
            if (keepalive >= 5) {
                if (this.messageDelaysStatus) {
                    this.messageDelaysStatus.textContent = 'Typing keepalive must be < 5 seconds';
                    this.messageDelaysStatus.dataset.variant = 'error';
                }
                this._messageDelaysStatusTimer = setTimeout(() => {
                    if (this.messageDelaysStatus) {
                        this.messageDelaysStatus.textContent = '';
                        delete this.messageDelaysStatus.dataset.variant;
                    }
                    this._messageDelaysStatusTimer = null;
                }, 3000);
                return;
            }
        }
        
        // Build payload (convert seconds to ms)
        const payload = {};
        
        if (this.readingDelayMin && this.readingDelayMax) {
            payload.waitBeforeTypingMs = {
                min: parseFloat(this.readingDelayMin.value) * 1000,
                max: parseFloat(this.readingDelayMax.value) * 1000
            };
        }
        
        if (this.typingDurationMin && this.typingDurationMax) {
            payload.typingDurationMs = {
                min: parseFloat(this.typingDurationMin.value) * 1000,
                max: parseFloat(this.typingDurationMax.value) * 1000
            };
        }
        
        if (this.typingKeepaliveInput) {
            payload.typingKeepaliveMs = parseFloat(this.typingKeepaliveInput.value) * 1000;
        }
        
        // Show saving status
        if (this.messageDelaysStatus) {
            this.messageDelaysStatus.textContent = 'Saving...';
            delete this.messageDelaysStatus.dataset.variant;
        }
        if (this._messageDelaysStatusTimer) {
            clearTimeout(this._messageDelaysStatusTimer);
            this._messageDelaysStatusTimer = null;
        }
        
        // Disable save button
        if (this.messageDelaysSaveBtn) {
            this.messageDelaysSaveBtn.disabled = true;
        }
        
        try {
            const response = await fetch('/api/config/message-delays', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await response.json();
            if (!response.ok || (data && data.success === false)) {
                throw new Error((data && data.message) || ('HTTP ' + response.status));
            }
            
            if (this.messageDelaysStatus) {
                this.messageDelaysStatus.textContent = 'Configuration saved successfully';
                this.messageDelaysStatus.dataset.variant = 'success';
            }
            
            this.log('✅ Message delays configuration saved');
            
            // Reload to ensure UI is in sync (but preserve the success message)
            const successMessage = this.messageDelaysStatus ? this.messageDelaysStatus.textContent : '';
            await this.loadMessageDelaysConfig();
            if (this.messageDelaysStatus && successMessage) {
                this.messageDelaysStatus.textContent = successMessage;
                this.messageDelaysStatus.dataset.variant = 'success';
            }
        } catch (error) {
            if (this.messageDelaysStatus) {
                this.messageDelaysStatus.textContent = 'Failed to save: ' + error.message;
                this.messageDelaysStatus.dataset.variant = 'error';
            }
            this.log('❌ Error saving message delays config: ' + error.message);
        } finally {
            if (this.messageDelaysSaveBtn) {
                this.messageDelaysSaveBtn.disabled = false;
            }
            this._messageDelaysStatusTimer = setTimeout(() => {
                if (this.messageDelaysStatus) {
                    this.messageDelaysStatus.textContent = '';
                    delete this.messageDelaysStatus.dataset.variant;
                }
                this._messageDelaysStatusTimer = null;
            }, 3000);
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
                    this.log(`✅ Session detected for ${label}. You can set it active now.`);
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
            this.log('✅ ' + data.message);
            this.pollForSession(accountId, label, 120000);
        } catch (error) {
            this.log('❌ ' + (error && error.message ? error.message : 'Error starting console login'));
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
                this.globalPersonaId = selectedPersona;
                await this.loadChats({ silent: true, preserveActive: true });
                this.refreshChatPersonaOptions();
            } else {
                this.log('❌ ' + (data.message || 'Failed to change personality'));
            }
        } catch (error) {
            this.log('❌ Error changing personality: ' + error.message);
        }
    }

    handleChatSearch() {
        if (!this.chatSearchInput) return;
        this.chatSearchTerm = this.chatSearchInput.value || '';
        this.applyChatFilter();
    }

    handleChatScroll() {
        if (!this.chatMessagesEl) return;
        const { scrollTop, scrollHeight, clientHeight } = this.chatMessagesEl;
        const nearBottom = scrollHeight - (scrollTop + clientHeight) < 80;
        this.chatAutoScroll = nearBottom;
    }

    updateChatStatus(message, variant = 'info', options = {}) {
        if (!this.chatStatusBanner) return;
        if (this._chatStatusTimer) {
            clearTimeout(this._chatStatusTimer);
            this._chatStatusTimer = null;
        }
        if (!message) {
            this.chatStatusBanner.textContent = '';
            this.chatStatusBanner.setAttribute('hidden', '');
            delete this.chatStatusBanner.dataset.variant;
            return;
        }
        this.chatStatusBanner.textContent = message;
        if (variant && variant !== 'info') {
            this.chatStatusBanner.dataset.variant = variant;
        } else {
            delete this.chatStatusBanner.dataset.variant;
        }
        this.chatStatusBanner.removeAttribute('hidden');
        const { autoClear = false } = options || {};
        if (autoClear) {
            this._chatStatusTimer = setTimeout(() => {
                this.updateChatStatus('', 'info');
            }, 4000);
        }
    }

    updateActiveChatHeader(chat) {
        if (!this.chatTitleEl || !this.chatMetaEl) {
            return;
        }
        if (!chat) {
            this.chatTitleEl.textContent = 'Pick a chat to preview';
            this.chatMetaEl.textContent = 'Messages will appear here in real time.';
            this.chatMetaEl.removeAttribute('title');
            this.activeChatPersonaId = null;
            this.activeChatUsesDefaultPersona = null;
            this.activeChatPersonaUpdatedAt = null;
            this.refreshChatPersonaOptions();
            this.updateChatPersonaBadge();
            return;
        }

        const typeLabel = chat.type === 'private'
            ? 'Direct chat'
            : chat.type === 'group'
                ? 'Group conversation'
                : 'Channel';

        this.chatTitleEl.textContent = chat.title || 'Conversation';

        const personaId = chat.personaId || null;
        const personaLabel = chat.personaLabel || (personaId ? formatPersonaName(personaId) : '');
        const usesDefault = typeof chat.usesDefaultPersona === 'boolean' ? chat.usesDefaultPersona : null;
        const personaUpdatedAt = Number.isFinite(chat.personaUpdatedAt) ? chat.personaUpdatedAt : null;

        const metaParts = [typeLabel];
        if (personaLabel) {
            metaParts.push(usesDefault === false ? `Persona: ${personaLabel} (custom)` : `Persona: ${personaLabel}`);
        }

        if (Number.isFinite(chat.lastTimestamp)) {
            metaParts.push(`Updated ${formatRelativeTime(chat.lastTimestamp)}`);
        } else {
            metaParts.push('Live conversation');
        }
        this.chatMetaEl.textContent = metaParts.join(' · ');

        const titleParts = [];
        if (Number.isFinite(chat.lastTimestamp)) {
            titleParts.push(`Last message: ${new Date(chat.lastTimestamp).toLocaleString()}`);
        }
        if (Number.isFinite(personaUpdatedAt)) {
            titleParts.push(`Persona changed: ${new Date(personaUpdatedAt).toLocaleString()}`);
        }
        if (titleParts.length > 0) {
            this.chatMetaEl.title = titleParts.join(' • ');
        } else {
            this.chatMetaEl.removeAttribute('title');
        }

        if (personaId !== undefined && personaId !== null) {
            this.activeChatPersonaId = personaId;
        }
        if (usesDefault !== undefined && usesDefault !== null) {
            this.activeChatUsesDefaultPersona = usesDefault;
        }
        if (personaUpdatedAt !== undefined && personaUpdatedAt !== null) {
            this.activeChatPersonaUpdatedAt = personaUpdatedAt;
        }

        this.refreshChatPersonaOptions();
    }

    refreshChatPersonaOptions() {
        if (!this.chatPersonaSelect) {
            return;
        }

        const personas = Array.isArray(this.availablePersonas) ? this.availablePersonas : [];
        const activePersonaId = this.activeChatPersonaId || '';

        this._suppressChatPersonaChange = true;
        this.chatPersonaSelect.innerHTML = '';

        if (personas.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'No personas available';
            this.chatPersonaSelect.appendChild(option);
            this.chatPersonaSelect.disabled = true;
            this._suppressChatPersonaChange = false;
            if (this.chatPersonaResetBtn) {
                this.chatPersonaResetBtn.disabled = true;
            }
            this.updateChatPersonaBadge();
            return;
        }

        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Select a persona';
        placeholder.disabled = true;
        this.chatPersonaSelect.appendChild(placeholder);

        personas.forEach(persona => {
            const option = document.createElement('option');
            option.value = persona;
            option.textContent = formatPersonaName(persona);
            this.chatPersonaSelect.appendChild(option);
        });

        if (activePersonaId && !personas.includes(activePersonaId)) {
            const option = document.createElement('option');
            option.value = activePersonaId;
            option.textContent = `${formatPersonaName(activePersonaId)} (custom)`;
            option.dataset.variant = 'custom';
            this.chatPersonaSelect.appendChild(option);
        }

        if (activePersonaId && Array.from(this.chatPersonaSelect.options).some(option => option.value === activePersonaId)) {
            this.chatPersonaSelect.value = activePersonaId;
        } else {
            this.chatPersonaSelect.value = '';
        }

        this._suppressChatPersonaChange = false;

        const hasChat = !!this.activeChatId;
        const disableSelect = !hasChat || this.chatPersonaBusy;
        this.chatPersonaSelect.disabled = disableSelect;

        if (this.chatPersonaResetBtn) {
            const disableReset = disableSelect || this.activeChatUsesDefaultPersona !== false;
            this.chatPersonaResetBtn.disabled = disableReset;
        }
    }


    async handleActiveChatPersonaChange() {
        if (!this.chatPersonaSelect || this._suppressChatPersonaChange) {
            return;
        }
        const chatId = this.activeChatId;
        if (!chatId) {
            this.refreshChatPersonaOptions();
            return;
        }

        const personaId = this.chatPersonaSelect.value;
        if (!personaId || this.chatPersonaBusy) {
            this.refreshChatPersonaOptions();
            return;
        }

        const previous = this.activeChatPersonaId;
        this.chatPersonaBusy = true;
        this.refreshChatPersonaOptions();
        this.updateChatStatus(`Updating persona to ${formatPersonaName(personaId)}…`, 'info');

        try {
            const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/personality`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ persona: personaId }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.success === false) {
                throw new Error(data?.message || `Failed to update persona (${response.status})`);
            }
            this.updateChatStatus(data?.message || 'Chat persona updated.', 'success', { autoClear: true });
            this.applyPersonaSummaryToState(chatId, data.persona);
        } catch (error) {
            const message = error && error.message ? error.message : 'Failed to update persona.';
            this.updateChatStatus(message, 'error');
            this._suppressChatPersonaChange = true;
            if (this.chatPersonaSelect) {
                this.chatPersonaSelect.value = previous || '';
            }
            this._suppressChatPersonaChange = false;
        } finally {
            this.chatPersonaBusy = false;
            this.refreshChatPersonaOptions();
        }
    }

    async resetActiveChatPersona() {
        if (!this.activeChatId || this.chatPersonaBusy) {
            return;
        }

        const chatId = this.activeChatId;
        this.chatPersonaBusy = true;
        this.refreshChatPersonaOptions();
        this.updateChatStatus('Resetting persona to default…', 'info');

        try {
            const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/personality`, { method: 'DELETE' });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.success === false) {
                throw new Error(data?.message || `Failed to reset persona (${response.status})`);
            }
            this.updateChatStatus(data?.message || 'Chat persona reset to default.', 'success', { autoClear: true });
            this.applyPersonaSummaryToState(chatId, data.persona);
        } catch (error) {
            const message = error && error.message ? error.message : 'Failed to reset persona.';
            this.updateChatStatus(message, 'error');
        } finally {
            this.chatPersonaBusy = false;
            this.refreshChatPersonaOptions();
        }
    }

    applyPersonaSummaryToState(chatId, persona) {
        if (!chatId || !persona || typeof persona !== 'object') {
            this.refreshChatPersonaOptions();
            return;
        }

        const personaId = typeof persona.personaId === 'string' ? persona.personaId : null;
        const personaLabel = typeof persona.personaLabel === 'string'
            ? persona.personaLabel
            : (personaId ? formatPersonaName(personaId) : '');
        const usesDefault = typeof persona.usesDefaultPersona === 'boolean' ? persona.usesDefaultPersona : null;
        const updatedAt = Number.isFinite(persona.updatedAt) ? persona.updatedAt : null;

        const changed = this.updateChatCollections({
            id: chatId,
            personaId,
            personaLabel,
            usesDefaultPersona: usesDefault,
            personaUpdatedAt: updatedAt,
        });

        if (chatId === this.activeChatId) {
            const chatInfo = this.chatListData.find(chat => chat.id === chatId) || null;
            if (chatInfo) {
                this.updateActiveChatHeader(chatInfo);
            } else {
                this.activeChatPersonaId = personaId;
                this.activeChatUsesDefaultPersona = usesDefault;
                this.activeChatPersonaUpdatedAt = updatedAt;
                this.refreshChatPersonaOptions();
                this.updateChatPersonaBadge();
            }
        }

        if (changed) {
            this.renderChatList();
        }
    }

    updateChatCollections(chat) {
        if (!chat || !chat.id) {
            return false;
        }

        let changed = false;
        const apply = (collection) => {
            if (!Array.isArray(collection)) return;
            collection.forEach(item => {
                if (item.id === chat.id) {
                    const fields = ['personaId', 'personaLabel', 'usesDefaultPersona', 'personaUpdatedAt'];
                    fields.forEach(field => {
                        if (Object.prototype.hasOwnProperty.call(chat, field) && chat[field] !== undefined && chat[field] !== null && item[field] !== chat[field]) {
                            item[field] = chat[field];
                            changed = true;
                        }
                    });
                }
            });
        };

        apply(this.chatListData);
        apply(this.filteredChats);
        return changed;
    }

    applyChatFilter() {
        if (!Array.isArray(this.chatListData)) {
            this.chatListData = [];
        }
        const term = (this.chatSearchTerm || '').toLowerCase().trim();
        if (!term) {
            this.filteredChats = this.chatListData.slice();
        } else {
            this.filteredChats = this.chatListData.filter(chat => {
                const personaHint = `${chat.personaLabel || chat.personaId || ''}`;
                const haystack = `${chat.title || ''} ${chat.lastMessage || ''} ${personaHint}`.toLowerCase();
                return haystack.includes(term);
            });
        }
        this.renderChatList();
    }

    renderChatList() {
        if (!this.chatListContainer) return;
        this.chatListContainer.innerHTML = '';
        const chats = Array.isArray(this.filteredChats) ? this.filteredChats : [];
        const hasChats = chats.length > 0;
        if (this.chatEmptyState) {
            if (hasChats) {
                this.chatEmptyState.setAttribute('hidden', '');
            } else {
                this.chatEmptyState.removeAttribute('hidden');
            }
        }

        chats.forEach(chat => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'chat-list-item';
            button.dataset.chatId = chat.id;
            button.setAttribute('role', 'option');
            button.title = chat.title || '';
            button.addEventListener('click', () => {
                this.setActiveChat(chat.id, { triggerFetch: true });
                if (this.isMobile()) this.closeMobileSidebar();
            });

            const titleEl = document.createElement('div');
            titleEl.className = 'chat-list-title';
            titleEl.textContent = chat.title || 'Conversation';

            const snippetEl = document.createElement('div');
            snippetEl.className = 'chat-list-snippet';
            snippetEl.textContent = chat.lastMessage || 'No messages yet';

            const metaEl = document.createElement('div');
            metaEl.className = 'chat-list-meta';

            if (chat.type) {
                const typeEl = document.createElement('span');
                typeEl.className = 'chat-list-type';
                typeEl.textContent = chat.type === 'private' ? 'Direct' : chat.type === 'group' ? 'Group' : 'Channel';
                metaEl.appendChild(typeEl);
            }

            if (Number.isFinite(chat.lastTimestamp)) {
                const timeEl = document.createElement('span');
                timeEl.textContent = formatRelativeTime(chat.lastTimestamp);
                timeEl.title = new Date(chat.lastTimestamp).toLocaleString();
                metaEl.appendChild(timeEl);
            }

            if (Number.isFinite(chat.unreadCount) && chat.unreadCount > 0) {
                const unreadEl = document.createElement('span');
                unreadEl.className = 'chat-list-unread';
                unreadEl.textContent = chat.unreadCount > 99 ? '99+' : String(chat.unreadCount);
                metaEl.appendChild(unreadEl);
            }

            if (chat.personaLabel || chat.personaId) {
                const personaEl = document.createElement('span');
                personaEl.className = 'chat-list-persona';
                personaEl.textContent = chat.personaLabel || formatPersonaName(chat.personaId);
                if (chat.usesDefaultPersona === false) {
                    personaEl.dataset.variant = 'custom';
                    personaEl.title = 'Custom persona';
                } else {
                    personaEl.dataset.variant = 'default';
                    personaEl.title = 'Default persona';
                }
                metaEl.appendChild(personaEl);
            }

            button.appendChild(titleEl);
            button.appendChild(snippetEl);
            if (metaEl.childNodes.length > 0) {
                button.appendChild(metaEl);
            }

            this.chatListContainer.appendChild(button);
        });

        this.highlightActiveChat();
    }

    highlightActiveChat() {
        if (!this.chatListContainer) return;
        const buttons = Array.from(this.chatListContainer.querySelectorAll('.chat-list-item'));
        buttons.forEach(button => {
            const id = button.dataset.chatId;
            const isActive = id === this.activeChatId;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-selected', String(isActive));
        });
    }

    loadChatRefreshSpeed() {
        const fallback = 'normal';
        try {
            const stored = localStorage.getItem('chatRefreshSpeed');
            if (stored && this.chatRefreshRates && this.chatRefreshRates[stored]) {
                return stored;
            }
        } catch (error) {
            // ignore storage errors
        }
        return fallback;
    }

    persistChatRefreshSpeed() {
        try {
            localStorage.setItem('chatRefreshSpeed', this.chatRefreshSpeed);
        } catch (error) {
            // ignore storage errors
        }
    }

    updateChatSpeedToggleUI() {
        if (!Array.isArray(this.chatSpeedButtons)) return;
        this.chatSpeedButtons.forEach(button => {
            const speed = button.dataset.speed || 'normal';
            const config = this.chatRefreshRates?.[speed];
            const isActive = speed === this.chatRefreshSpeed;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-pressed', String(isActive));
            if (isActive) {
                button.setAttribute('aria-current', 'true');
            } else {
                button.removeAttribute('aria-current');
            }
            if (config && Number.isFinite(config.interval)) {
                const seconds = config.interval / 1000;
                let formatted;
                if (seconds >= 1) {
                    const precise = seconds < 3 ? Number(seconds.toFixed(1)) : Math.round(seconds);
                    formatted = `${precise}s`;
                } else {
                    formatted = `${Math.round(config.interval)}ms`;
                }
                button.title = `Refresh every ${formatted}`;
            }
        });
    }

    // Mobile helpers
    isMobile() {
        try {
            return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 720px)').matches;
        } catch {
            return false;
        }
    }

    toggleMobileSidebar() {
        if (!this.chatPanel) return;
        const open = !this.chatPanel.classList.contains('mobile-sidebar-open');
        if (open) {
            this.openMobileSidebar();
        } else {
            this.closeMobileSidebar();
        }
    }

    openMobileSidebar() {
        if (!this.chatPanel) return;
        this.chatPanel.classList.add('mobile-sidebar-open');
        if (typeof document !== 'undefined' && document.body) {
            document.body.classList.add('no-scroll');
        }
        if (this.chatSearchInput && this.chatSearchInput.focus) {
            try { this.chatSearchInput.focus({ preventScroll: true }); } catch {}
        }
    }

    closeMobileSidebar() {
        if (!this.chatPanel) return;
        this.chatPanel.classList.remove('mobile-sidebar-open');
        if (typeof document !== 'undefined' && document.body) {
            document.body.classList.remove('no-scroll');
        }
    }

    setChatRefreshSpeed(speed) {
        const fallback = 'normal';
        const nextSpeed = this.chatRefreshRates && this.chatRefreshRates[speed] ? speed : fallback;
        if (this.chatRefreshSpeed === nextSpeed) {
            return;
        }
        this.chatRefreshSpeed = nextSpeed;
        this.persistChatRefreshSpeed();
        this.updateChatSpeedToggleUI();
        if (this.currentTab === 'chats') {
            this.stopChatPolling();
            this.startChatPolling();
        }
    }

    setActiveChat(chatId, { triggerFetch = false } = {}) {
        if (chatId === this.activeChatId && !triggerFetch) {
            return;
        }
        this.activeChatId = chatId;
        this.highlightActiveChat();

        if (!chatId) {
            this.updateActiveChatHeader(null);
            this.renderChatMessages([]);
            this.updateChatComposerState();
            return;
        }

        const chat = this.chatListData.find(item => item.id === chatId) || null;
        if (chat) {
            this.updateActiveChatHeader(chat);
        } else {
            this.updateActiveChatHeader({ id: chatId, title: 'Conversation', type: 'private', lastTimestamp: Date.now() });
        }

        this.chatAutoScroll = true;
        this.updateChatComposerState();
        if (triggerFetch) {
            this.refreshActiveChat({ force: true });
        }
    }

    startChatPolling() {
        if (!this.chatListContainer) return;
        if (this.chatPollInterval) return;
        if (!this.botIsRunning) {
            this.loadChats({ silent: false, preserveActive: true });
            return;
        }
        this.stopChatPolling();
        this.loadChats({ silent: false, preserveActive: true });
        this.refreshActiveChat({ force: true, silent: true });
        this.chatPollTick = 0;
        const config = this.chatRefreshRates?.[this.chatRefreshSpeed] || this.chatRefreshRates.normal || { interval: 5000, listEvery: 3 };
        const intervalMs = Math.max(500, Number(config.interval) || 5000);
        const listEvery = Math.max(1, Math.round(Number.isFinite(config.listEvery) ? config.listEvery : 3));
        this.chatPollInterval = setInterval(() => {
            if (!this.botIsRunning) {
                this.stopChatPolling();
                return;
            }
            this.chatPollTick += 1;
            this.refreshActiveChat({ silent: true });
            if (this.chatPollTick % listEvery === 0) {
                this.loadChats({ silent: true, preserveActive: true });
            }
        }, intervalMs);
    }

    stopChatPolling() {
        if (this.chatPollInterval) {
            clearInterval(this.chatPollInterval);
            this.chatPollInterval = null;
        }
        this.chatPollTick = 0;
    }

    async loadChats({ silent = false, preserveActive = true, force = false } = {}) {
        if (!this.chatListContainer) return;

        if (!this.botIsRunning && !force) {
            this.chatListData = [];
            this.applyChatFilter();
            if (!silent) {
                this.updateChatStatus('Start the bot to load conversations.', 'warning');
            }
            return;
        }

        if (this.loadingChats && !force) {
            return;
        }
        this.loadingChats = true;

        if (!silent) {
            this.updateChatStatus('Loading chats…', 'info');
        }

        try {
            const response = await fetch('/api/chats');
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.success === false) {
                throw new Error(data?.message || `Failed to load chats (${response.status})`);
            }
            const chats = Array.isArray(data.chats) ? data.chats : [];
            this.chatListData = chats;
            this.applyChatFilter();

            if (preserveActive && this.activeChatId && chats.some(chat => chat.id === this.activeChatId)) {
                const activeChat = chats.find(chat => chat.id === this.activeChatId);
                if (activeChat) {
                    this.updateActiveChatHeader(activeChat);
                }
                // keep current selection
            } else if (chats.length > 0) {
                this.setActiveChat(chats[0].id, { triggerFetch: !this.activeChatId });
            } else {
                this.setActiveChat(null);
            }

            if (!silent) {
                if (chats.length === 0) {
                    this.updateChatStatus('No chats yet. Conversations will appear once messages arrive.', 'info');
                } else {
                    this.updateChatStatus(`Loaded ${chats.length} chat${chats.length === 1 ? '' : 's'}.`, 'success', { autoClear: true });
                }
            }
        } catch (error) {
            if (!silent) {
                const message = error && error.message ? error.message : 'Failed to load chats.';
                this.updateChatStatus(message, 'error');
            } else {
                console.warn('Failed to load chats:', error);
            }
        } finally {
            this.loadingChats = false;
            this.updateChatComposerState();
        }
    }

    async refreshActiveChat({ force = false, silent = false } = {}) {
        if (!this.activeChatId) {
            if (!silent) {
                this.updateChatStatus('Select a chat to preview live messages.', 'info');
            }
            this.renderChatMessages([]);
            this.updateChatComposerState();
            return;
        }

        if (this.chatLoading && !force) {
            return;
        }

        this.chatLoading = true;
        if (this.chatMessagesEl) {
            this.chatMessagesEl.setAttribute('aria-busy', 'true');
        }
        if (!silent) {
            this.updateChatStatus('Updating conversation…', 'info');
        }

        try {
            // Capture the chat id at request time to avoid race conditions
            const requestedChatId = this.activeChatId;
            const response = await fetch(`/api/chats/${encodeURIComponent(requestedChatId)}`);
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.success === false) {
                throw new Error(data?.message || `Failed to load chat (${response.status})`);
            }

            // If the active chat changed while awaiting, bail out
            if (this.activeChatId !== requestedChatId) {
                return;
            }

            if (data.chat) {
                const headerMeta = {
                    id: data.chat.id,
                    title: data.chat.title,
                    type: data.chat.type,
                    lastTimestamp: Array.isArray(data.messages) && data.messages.length > 0
                        ? data.messages[data.messages.length - 1].timestamp
                        : undefined,
                    personaId: data.chat.personaId,
                    personaLabel: data.chat.personaLabel,
                    usesDefaultPersona: data.chat.usesDefaultPersona,
                    personaUpdatedAt: data.chat.personaUpdatedAt,
                };
                this.updateActiveChatHeader(headerMeta);
                const personaChanged = this.updateChatCollections({
                    id: data.chat.id,
                    personaId: data.chat.personaId,
                    personaLabel: data.chat.personaLabel,
                    usesDefaultPersona: data.chat.usesDefaultPersona,
                    personaUpdatedAt: data.chat.personaUpdatedAt,
                });
                if (personaChanged) {
                    this.renderChatList();
                }
            }

            const messages = Array.isArray(data.messages) ? data.messages : [];
            const previous = this.chatRenderCache.get(requestedChatId);
            const latestId = messages.length > 0 ? messages[messages.length - 1].id : null;
            const latestCount = messages.length;

            if (!force && previous && previous.lastId === latestId && previous.count === latestCount) {
                if (!silent) {
                    this.updateChatStatus('Conversation is up to date.', 'success', { autoClear: true });
                }
                return;
            }

            this.chatRenderCache.set(requestedChatId, {
                lastId: latestId,
                count: latestCount,
                timestamp: Date.now(),
            });

            this.renderChatMessages(messages, { forceScroll: force });
            if (!silent) {
                if (messages.length === 0) {
                    this.updateChatStatus('No messages in this chat yet.', 'info');
                } else {
                    this.updateChatStatus(`Loaded ${messages.length} message${messages.length === 1 ? '' : 's'}.`, 'success', { autoClear: true });
                }
            }
        } catch (error) {
            if (!silent) {
                const message = error && error.message ? error.message : 'Failed to load chat history.';
                this.updateChatStatus(message, 'error');
            } else {
                console.warn('Failed to refresh chat:', error);
            }
        } finally {
            this.chatLoading = false;
            if (this.chatMessagesEl) {
                this.chatMessagesEl.setAttribute('aria-busy', 'false');
            }
            this.updateChatComposerState();
        }
    }

    renderChatMessages(messages = [], { forceScroll = false } = {}) {
        if (!this.chatMessagesEl) return;

        const container = this.chatMessagesEl;
        const { scrollTop, scrollHeight, clientHeight } = container;
        const nearBottom = scrollHeight - (scrollTop + clientHeight) < 80;
        const shouldStick = forceScroll || this.chatAutoScroll || nearBottom;

        container.innerHTML = '';

        if (!messages || messages.length === 0) {
            container.classList.add('empty');
            const hint = document.createElement('div');
            hint.className = 'chat-empty-hint';
            hint.textContent = 'No messages yet. Send a message to start the conversation.';
            container.appendChild(hint);
            this.chatAutoScroll = true;
            return;
        }

        container.classList.remove('empty');

        messages.forEach(message => {
            const wrapper = document.createElement('div');
            wrapper.className = `chat-message ${message.from === 'bot' ? 'outbound' : 'inbound'}`;

            const bubble = document.createElement('div');
            bubble.className = 'chat-bubble';
            bubble.textContent = message.text || '';
            wrapper.appendChild(bubble);

            const meta = document.createElement('div');
            meta.className = 'chat-message-meta';
            const parts = [];
            if (message.sender) {
                parts.push(message.sender);
            }
            if (Number.isFinite(message.timestamp)) {
                const date = new Date(message.timestamp);
                parts.push(date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
                meta.title = date.toLocaleString();
            }
            meta.textContent = parts.join(' • ');
            wrapper.appendChild(meta);

            container.appendChild(wrapper);
        });

        if (shouldStick) {
            container.scrollTop = container.scrollHeight;
            this.chatAutoScroll = true;
        } else {
            this.chatAutoScroll = false;
        }
    }

    updateChatComposerState() {
        if (!this.chatMessageInput || !this.chatSendBtn) return;
        const hasChat = !!this.activeChatId;
        const running = this.botIsRunning;
        const message = this.chatMessageInput.value || '';
        const busy = this.chatSending || this.chatBlending;
        this.chatMessageInput.disabled = !hasChat || !running || busy;
        this.chatMessageInput.placeholder = running ? 'Write a reply…' : 'Start the bot to reply';
        const hasText = message.trim().length > 0;
        this.chatSendBtn.disabled = !hasChat || !running || this.chatSending || this.chatBlending || !hasText;
        if (this.chatBlendBtn) {
            this.chatBlendBtn.disabled = !hasChat || !running || busy;
        }
    }

    async submitChatMessage() {
        if (!this.chatMessageInput || !this.chatSendBtn || !this.activeChatId) {
            return;
        }
        const text = this.chatMessageInput.value.trim();
        if (!text) {
            return;
        }
        if (!this.botIsRunning) {
            this.updateChatStatus('Start the bot before sending messages.', 'warning', { autoClear: true });
            return;
        }
        if (this.chatSending) {
            return;
        }

        this.chatSending = true;
        this.updateChatComposerState();
        this.updateChatStatus('Sending message…', 'info');

        try {
            const response = await fetch(`/api/chats/${encodeURIComponent(this.activeChatId)}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.success === false) {
                throw new Error(data?.message || `Failed to send message (${response.status})`);
            }
            this.chatMessageInput.value = '';
            this.chatAutoScroll = true;
            this.updateChatStatus(data?.message || 'Message sent.', 'success', { autoClear: true });
            await this.refreshActiveChat({ force: true, silent: true });
            this.loadChats({ silent: true, preserveActive: true });
        } catch (error) {
            const message = error && error.message ? error.message : 'Failed to send message.';
            this.updateChatStatus(message, 'error');
        } finally {
            this.chatSending = false;
            this.updateChatComposerState();
        }
    }

    async sendBlendReply() {
        if (!this.activeChatId || !this.chatBlendBtn) {
            return;
        }
        if (!this.botIsRunning) {
            this.updateChatStatus('Start the bot before sending messages.', 'warning', { autoClear: true });
            return;
        }
        if (this.chatBlending) {
            return;
        }

        this.chatBlending = true;
        this.updateChatComposerState();
        this.updateChatStatus('Crafting blend reply…', 'info');

        try {
            const response = await fetch(`/api/chats/${encodeURIComponent(this.activeChatId)}/blend`, {
                method: 'POST'
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.success === false) {
                throw new Error(data?.message || `Failed to send blend reply (${response.status})`);
            }
            if (this.chatMessageInput) {
                this.chatMessageInput.value = '';
            }
            this.chatAutoScroll = true;
            const preview = typeof data.preview === 'string' ? data.preview.trim() : '';
            let statusMessage = data?.message || 'Blend reply sent.';
            if (preview) {
                const trimmed = preview.length > 200 ? `${preview.slice(0, 197)}…` : preview;
                statusMessage += ` Preview: ${trimmed}`;
            }
            this.updateChatStatus(statusMessage, 'success', { autoClear: true });
            await this.refreshActiveChat({ force: true, silent: true });
            this.loadChats({ silent: true, preserveActive: true });
        } catch (error) {
            const message = error && error.message ? error.message : 'Failed to send blend reply.';
            this.updateChatStatus(message, 'error');
        } finally {
            this.chatBlending = false;
            this.updateChatComposerState();
        }
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
        this.currentTab = tabId;
        if (tabId === 'metrics') {
            this.refreshMetrics();
            window.requestAnimationFrame(() => this.resizeCharts());
        } else if (tabId === 'activity' && this.logDiv) {
            this.logDiv.scrollTop = this.logDiv.scrollHeight;
        }
        if (tabId === 'chats') {
            this.startChatPolling();
        } else {
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
        // Destroy existing charts to avoid Chart.js configuration proxy issues
        if (this.timelineChart) {
            this.timelineChart.destroy();
            this.timelineChart = null;
        }
        if (this.providerChart) {
            this.providerChart.destroy();
            this.providerChart = null;
        }

        // Reinitialize charts with new theme colors
        this.initializeCharts();

        // Refresh data in the new charts
        this.refreshMetrics();
    }

    // Ensure model and key rows reflect provider selection
    toggleModelVisibility() {
        const provider = this.providerSelect ? this.providerSelect.value : 'pollinations';
        const show = provider === 'openrouter';
        if (this.openrouterModelRow) this.openrouterModelRow.style.display = show ? '' : 'none';
        if (this.openrouterKeyRow) this.openrouterKeyRow.style.display = show ? '' : 'none';
    }

    async saveOpenrouterKey() {
        const input = this.openrouterApiKeyInput;
        if (!input) return;
        const key = (input.value || '').trim();
        try {
            const resp = await fetch('/api/config/llm/key', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key }),
            });
            const data = await resp.json();
            if (!resp.ok || !data.success) {
                throw new Error(data?.message || 'Failed to save key');
            }
            if (this.openrouterKeyStatus) {
                this.openrouterKeyStatus.textContent = data.hasOpenrouterKey ? 'Key set' : 'Key cleared';
            }
            this.log('OpenRouter API key saved');
            // For safety, clear the input after saving
            input.value = '';
        } catch (err) {
            this.log('Error saving OpenRouter key: ' + (err && err.message ? err.message : String(err)));
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
        } else {
            // Default to 'configuration' if no saved tab or saved tab is 'overview'
            this.activate('configuration', { focusButton: false, skipStore: true });
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
    // Ensure status polling starts even if earlier code aborted
    if (typeof controller.checkStatus === 'function') {
        try { controller.checkStatus(); } catch (e) {}
        try { setInterval(() => controller.checkStatus(), 5000); } catch (e) {}
    }
});


