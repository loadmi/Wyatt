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

        this.startBtn.addEventListener('click', () => this.startBot());
        this.stopBtn.addEventListener('click', () => this.stopBot());
        this.personaSelect.addEventListener('change', () => this.changePersona());
        this.providerSelect.addEventListener('change', () => this.changeProvider());
        this.openrouterModelSelect.addEventListener('change', () => this.changeOpenRouterModel());

        // Check initial status
        this.checkStatus();

        // Load available personalities
        this.loadPersonalities();

        // Load LLM configuration
        this.loadLLMConfig();

        // Check status every 5 seconds
        setInterval(() => this.checkStatus(), 5000);
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
        if (isRunning) {
            this.statusDiv.textContent = 'Status: Running';
            this.statusDiv.className = 'status running';
            this.startBtn.disabled = true;
            this.stopBtn.disabled = false;
        } else {
            this.statusDiv.textContent = 'Status: Stopped';
            this.statusDiv.className = 'status stopped';
            this.startBtn.disabled = false;
            this.stopBtn.disabled = true;
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
}

// Initialize the controller when the page loads
document.addEventListener('DOMContentLoaded', () => {
    const toggle = document.getElementById('themeToggle');
    const label = document.getElementById('themeLabel');
    const saved = localStorage.getItem('theme');
    const theme = (saved === 'light' || saved === 'dark') ? saved : 'dark';

    applyTheme(theme);

    if (toggle) {
        toggle.checked = theme === 'dark';
        updateThemeLabel(label, theme);
        toggle.addEventListener('change', () => {
            const newTheme = toggle.checked ? 'dark' : 'light';
            applyTheme(newTheme);
            updateThemeLabel(label, newTheme);
            try { localStorage.setItem('theme', newTheme); } catch (e) { }
        });
    }

    new BotController();
});


