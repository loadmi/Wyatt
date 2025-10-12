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

const METRICS_POLL_INTERVAL = 5000;
const PROVIDER_COLORS = ['#60a5fa', '#34d399', '#f97316', '#c084fc', '#22d3ee', '#f472b6', '#fbbf24'];
let metricsDashboard = null;

function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return 'Offline';
    const totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0 || parts.length > 0) parts.push(`${hours}h`);
    if (minutes > 0 || parts.length < 2) parts.push(`${minutes}m`);
    if (parts.length === 1) parts.push(`${seconds}s`);
    return parts.slice(0, 3).join(' ');
}

function formatNumber(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '0';
    return num.toLocaleString();
}

function formatLatency(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '—';
    if (ms >= 1000) {
        const seconds = ms / 1000;
        const fixed = seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1);
        return `${fixed}s`;
    }
    return `${Math.round(ms)} ms`;
}

function formatRelativeTime(timestamp) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '—';
    const diff = Date.now() - timestamp;
    if (diff < 0) return 'just now';
    const seconds = Math.floor(diff / 1000);
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

function withAlpha(hex, alpha) {
    if (typeof hex !== 'string' || !hex.startsWith('#')) return hex;
    let r, g, b;
    if (hex.length === 4) {
        r = parseInt(hex[1] + hex[1], 16);
        g = parseInt(hex[2] + hex[2], 16);
        b = parseInt(hex[3] + hex[3], 16);
    } else if (hex.length === 7) {
        r = parseInt(hex.slice(1, 3), 16);
        g = parseInt(hex.slice(3, 5), 16);
        b = parseInt(hex.slice(5, 7), 16);
    } else {
        return hex;
    }
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

class MetricsDashboard {
    constructor() {
        this.uptimeEl = document.getElementById('metricsUptime');
        this.conversationsEl = document.getElementById('metricsConversations');
        this.inboundEl = document.getElementById('metricsInbound');
        this.outboundEl = document.getElementById('metricsOutbound');
        this.responseEl = document.getElementById('metricsResponse');
        this.contactsBody = document.getElementById('metricsContactsBody');
        this.throughputCanvas = document.getElementById('metricsThroughputChart');
        this.providerCanvas = document.getElementById('metricsProviderChart');
        this.throughputChart = null;
        this.providerChart = null;
        this.timer = null;

        if (!this.uptimeEl) {
            return;
        }

        this.fetchAndRender = this.fetchAndRender.bind(this);
        this.applyThemeToCharts = this.applyThemeToCharts.bind(this);

        this.fetchAndRender();
        this.timer = window.setInterval(this.fetchAndRender, METRICS_POLL_INTERVAL);
    }

    getThemeColors() {
        const styles = getComputedStyle(document.documentElement);
        const text = styles.getPropertyValue('--text').trim() || '#e5e7eb';
        const grid = styles.getPropertyValue('--log-border').trim() || '#2a3241';
        const inbound = '#60a5fa';
        const outbound = '#f97316';
        return { text, grid, inbound, outbound };
    }

    async fetchAndRender() {
        try {
            const response = await fetch('/api/metrics');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const snapshot = await response.json();
            this.render(snapshot);
        } catch (error) {
            console.warn('Failed to load metrics', error);
        }
    }

    render(snapshot) {
        if (!snapshot) return;
        this.updateCards(snapshot);
        this.updateContacts(snapshot);
        this.updateThroughputChart(snapshot);
        this.updateProviderChart(snapshot);
        this.applyThemeToCharts();
    }

    updateCards(snapshot) {
        if (this.uptimeEl) {
            const uptime = snapshot.running ? formatDuration(snapshot.uptimeMs) : 'Offline';
            this.uptimeEl.textContent = uptime;
        }
        if (this.conversationsEl) {
            const total = snapshot?.totals?.uniqueContacts ?? 0;
            this.conversationsEl.textContent = formatNumber(total);
        }
        if (this.inboundEl) {
            const inbound = snapshot?.totals?.inbound ?? 0;
            this.inboundEl.textContent = formatNumber(inbound);
        }
        if (this.outboundEl) {
            const outbound = snapshot?.totals?.outbound ?? 0;
            this.outboundEl.textContent = formatNumber(outbound);
        }
        if (this.responseEl) {
            const avg = snapshot?.response?.averageMs;
            this.responseEl.textContent = formatLatency(avg);
        }
    }

    updateContacts(snapshot) {
        if (!this.contactsBody) return;
        const contacts = Array.isArray(snapshot?.contacts) ? snapshot.contacts : [];
        if (contacts.length === 0) {
            this.contactsBody.innerHTML = '<tr><td colspan="4">No data yet.</td></tr>';
            return;
        }
        this.contactsBody.innerHTML = '';
        const top = contacts.slice(0, 8);
        for (const contact of top) {
            const row = document.createElement('tr');

            const idCell = document.createElement('td');
            idCell.textContent = contact?.contactId ?? 'unknown';
            row.appendChild(idCell);

            const inboundCell = document.createElement('td');
            inboundCell.textContent = formatNumber(contact?.inbound ?? 0);
            row.appendChild(inboundCell);

            const outboundCell = document.createElement('td');
            outboundCell.textContent = formatNumber(contact?.outbound ?? 0);
            row.appendChild(outboundCell);

            const seenCell = document.createElement('td');
            seenCell.textContent = formatRelativeTime(contact?.lastSeenAt ?? null);
            row.appendChild(seenCell);

            this.contactsBody.appendChild(row);
        }
    }

    updateThroughputChart(snapshot) {
        if (!this.throughputCanvas || typeof Chart === 'undefined') return;
        const entries = Array.isArray(snapshot?.throughput) ? snapshot.throughput : [];
        const minuteMs = 60 * 1000;
        const source = entries.length > 0 ? entries : Array.from({ length: 6 }, (_, idx) => {
            const offset = (5 - idx) * minuteMs;
            return {
                bucketStart: Date.now() - offset,
                inbound: 0,
                outbound: 0,
            };
        });

        const labels = source.map((entry) => {
            const date = new Date(entry.bucketStart);
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        });
        const inboundData = source.map((entry) => entry.inbound ?? 0);
        const outboundData = source.map((entry) => entry.outbound ?? 0);
        const colors = this.getThemeColors();
        const suggestedMax = Math.max(3, ...inboundData, ...outboundData);

        if (!this.throughputChart) {
            this.throughputChart = new Chart(this.throughputCanvas, {
                type: 'line',
                data: {
                    labels,
                    datasets: [
                        {
                            label: 'Inbound',
                            data: inboundData,
                            fill: true,
                            tension: 0.35,
                            borderWidth: 2,
                            borderColor: colors.inbound,
                            backgroundColor: withAlpha(colors.inbound, 0.25),
                            pointRadius: 0,
                        },
                        {
                            label: 'Outbound',
                            data: outboundData,
                            fill: true,
                            tension: 0.35,
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
                    interaction: { mode: 'index', intersect: false },
                    scales: {
                        x: {
                            ticks: { color: colors.text },
                            grid: { color: withAlpha(colors.grid, 0.3) },
                        },
                        y: {
                            beginAtZero: true,
                            suggestedMax,
                            ticks: { color: colors.text },
                            grid: { color: withAlpha(colors.grid, 0.3) },
                        },
                    },
                    plugins: {
                        legend: {
                            labels: { color: colors.text },
                        },
                    },
                },
            });
        } else {
            this.throughputChart.data.labels = labels;
            this.throughputChart.data.datasets[0].data = inboundData;
            this.throughputChart.data.datasets[1].data = outboundData;
            this.throughputChart.options.scales.y.suggestedMax = suggestedMax;
            this.throughputChart.update('none');
        }
    }

    updateProviderChart(snapshot) {
        if (!this.providerCanvas || typeof Chart === 'undefined') return;
        const providers = snapshot?.providers ?? {};
        const entries = Object.entries(providers).map(([name, stats]) => ({
            name,
            total: stats?.total ?? 0,
            ok: stats?.ok ?? 0,
            fail: stats?.fail ?? 0,
        })).filter((entry) => entry.total > 0);

        let labels;
        let data;
        let colors;
        let providerStats;

        if (entries.length === 0) {
            labels = ['No data'];
            data = [1];
            colors = ['#6b7280'];
            providerStats = [{ name: 'No data', total: 0, ok: 0, fail: 0 }];
        } else {
            labels = entries.map((entry) => entry.name);
            data = entries.map((entry) => entry.total);
            colors = entries.map((_, index) => PROVIDER_COLORS[index % PROVIDER_COLORS.length]);
            providerStats = entries;
        }

        const theme = this.getThemeColors();

        const dataset = {
            data,
            backgroundColor: colors.map((color) => withAlpha(color, 0.8)),
            borderColor: colors,
            borderWidth: 1,
            providerStats,
        };

        const tooltip = {
            callbacks: {
                label(context) {
                    const info = context.dataset.providerStats?.[context.dataIndex];
                    if (!info || info.total === 0) {
                        return `${context.label}: ${context.raw}`;
                    }
                    const successRate = info.total > 0 ? Math.round((info.ok / info.total) * 100) : 0;
                    return `${context.label}: ${info.total} (${successRate}% ok)`;
                },
            },
        };

        if (!this.providerChart) {
            this.providerChart = new Chart(this.providerCanvas, {
                type: 'doughnut',
                data: {
                    labels,
                    datasets: [dataset],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: { color: theme.text },
                        },
                        tooltip,
                    },
                },
            });
        } else {
            this.providerChart.data.labels = labels;
            this.providerChart.data.datasets[0].data = data;
            this.providerChart.data.datasets[0].backgroundColor = dataset.backgroundColor;
            this.providerChart.data.datasets[0].borderColor = dataset.borderColor;
            this.providerChart.data.datasets[0].providerStats = providerStats;
            this.providerChart.update('none');
        }
    }

    applyThemeToCharts() {
        const colors = this.getThemeColors();
        if (this.throughputChart) {
            this.throughputChart.options.scales.x.ticks.color = colors.text;
            this.throughputChart.options.scales.y.ticks.color = colors.text;
            this.throughputChart.options.scales.x.grid.color = withAlpha(colors.grid, 0.3);
            this.throughputChart.options.scales.y.grid.color = withAlpha(colors.grid, 0.3);
            this.throughputChart.data.datasets[0].borderColor = colors.inbound;
            this.throughputChart.data.datasets[0].backgroundColor = withAlpha(colors.inbound, 0.25);
            this.throughputChart.data.datasets[1].borderColor = colors.outbound;
            this.throughputChart.data.datasets[1].backgroundColor = withAlpha(colors.outbound, 0.25);
            this.throughputChart.options.plugins.legend.labels.color = colors.text;
            this.throughputChart.update('none');
        }
        if (this.providerChart) {
            this.providerChart.options.plugins.legend.labels.color = colors.text;
            this.providerChart.update('none');
        }
    }
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
            metricsDashboard?.applyThemeToCharts();
            try { localStorage.setItem('theme', newTheme); } catch (e) { }
        });
    }

    metricsDashboard = new MetricsDashboard();
    metricsDashboard?.applyThemeToCharts();
    new BotController();
});


