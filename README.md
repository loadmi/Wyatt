# Scam Bait Bot (TypeScript)

A TypeScript-based Telegram bot designed for educational purposes to engage with potential scammers using automated conversation flows.

## ⚠️ Important Disclaimer

**Account Safety:** Automating a user account is against Telegram's Terms of Service. Doing this, especially in a way that could be seen as spam, puts your account at high risk of being **banned permanently**. **It is strongly recommended to use a secondary, disposable phone number and account for this project, not your personal one.**

**Security:** Your `API_ID`, `API_HASH`, and especially your `SESSION_STRING` are highly sensitive. They grant full access to your Telegram account. Do not share them, commit them to Git, or expose them publicly. Telegram credentials are now managed via the in-app dashboard and saved to a local config file (`data/config.json`, which is git-ignored). Do not put Telegram credentials in `.env`.

## Prerequisites

1. **Node.js:** Version 18 or higher
2. **Telegram API Credentials:** Obtain your `api_id` and `api_hash` from [my.telegram.org](https://my.telegram.org)

## Installation

1. Clone or download this project
2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure Telegram in the dashboard (no secrets in `.env`):
   - Run the app and open the web UI
   - Go to Configuration → Telegram Accounts and add your `API_ID` and `API_HASH`
   - Start the bot from the dashboard; the first time, complete the login in the server console. The session string is saved automatically.

## Usage

### Development Mode (Recommended)
```bash
npm run dev
```

This will:
- Start the web interface at `http://localhost:3000`
- Automatically recompile TypeScript on changes
- Let you add a Telegram account in the dashboard and, upon starting the bot, prompt you to log in via the server console on first run
- Persist your Telegram session automatically in the local config

### Production Mode
```bash
# Build the project
npm run build

# Run the compiled code
npm start
```

## Testing

Run the TypeScript compiler to ensure the project builds without type errors:

```bash
npm run build
```

## Project Structure

```
scam-bait-bot-ts/
├── src/
│   ├── telegram/
│   │   ├── client.ts      # Telegram client setup and control
│   │   └── handlers.ts    # Message handling and conversation flow
│   └── web/
│       └── server.ts      # Express web server
├── public/
│   ├── index.html         # Web control panel
│   └── script.js          # Frontend JavaScript
├── dist/                  # Compiled JavaScript (generated)
├── .env                   # Environment variables (create this)
├── .gitignore
├── package.json
└── tsconfig.json
```

## Features

- **TypeScript:** Full type safety and better development experience
- **Web Interface:** Easy-to-use control panel for starting/stopping the bot
- **Live Metrics Dashboard:** Real-time uptime, throughput, response latency, LLM usage, and contact leaderboard visualizations
- **Conversation Flow:** Predefined responses to engage with potential scammers
- **Human-like Behavior:** Typing indicators and random delays
- **Session Management:** Secure session storage and reuse

## Configuration

The bot uses a simple conversation flow defined in `src/telegram/handlers.ts`. You can customize the responses by modifying the `conversationFlow` array.

In addition, general behavior timings are centralized in `src/config.ts` and can be overridden via environment variables in your `.env` file:

- `WAIT_BEFORE_TYPING_MS_MIN` / `WAIT_BEFORE_TYPING_MS_MAX` — initial silent wait before showing typing (default 10000–15000 ms)
- `TYPING_DURATION_MS_MIN` / `TYPING_DURATION_MS_MAX` — how long to show typing before replying (default 10000–15000 ms)
- `TYPING_KEEPALIVE_MS` — how often to refresh the typing indicator (default 4000 ms)

Incoming messages are marked as read by default right before the initial `waitBefore` delay begins.

If not set, sensible defaults are used. Edit `src/config.ts` if you prefer to hardcode different defaults.

### LLM Provider

The bot supports two LLM providers:

- `Pollinations` (default)
- `OpenRouter`

Use the dashboard to choose the provider; if `OpenRouter` is selected, you can set the model and manage the API key directly from the configuration panel. The OpenRouter key is stored locally in `data/config.json` and is never exposed via the API.

Note: `.env` is no longer used for `OPENROUTER_API_KEY`, `LLM_PROVIDER`, or `OPENROUTER_MODEL`. Manage these from the dashboard.

## Metrics Dashboard

The control panel now includes a telemetry section powered by the new `/api/metrics` endpoint. It tracks:

- Bot uptime and total inbound/outbound message counts
- Number of unique scammer conversations and latest contact activity
- Rolling throughput buckets rendered as a Chart.js line graph
- Average response latency and LLM provider request/failure breakdown (doughnut chart)
- A leaderboard of the most recent contacts with timestamps

Metrics refresh automatically every few seconds—no page reload required.

## API Endpoints

- `GET /api/status` - Get bot status
- `GET /api/metrics` - Retrieve telemetry snapshot for dashboards or automation
- `POST /api/start` - Start the bot
- `POST /api/stop` - Stop the bot

## Persistence

The dashboard settings are saved to a local JSON file so that choices survive restarts:

- File: `data/config.json`
- Persisted keys: `currentPersona`, `llmProvider`, `openrouterModel`

Notes:
- The file is created automatically on first run if it does not exist.
- Telegram accounts and sessions are stored here (redacted in API responses).

On startup, the server loads this file and applies values (validated against available personas and supported providers/models). Editing or deleting the file resets to defaults.

## License

ISC

## Contributing

This project is for educational purposes only. Please use responsibly and in accordance with Telegram's Terms of Service.




