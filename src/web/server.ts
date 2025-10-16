// src/web/server.ts
import express, { Express, Request, Response } from "express";
import path from "path";
import {
  startBot,
  stopBot,
  getStatus,
  startBotNonInteractive,
  listTelegramGroups,
  sendSentimentToGroup,
  getGroupChatHistory,
  sendMessageToGroup,
} from "../telegram/client";
import { initiateAccountConsoleLogin } from "../telegram/client";
import { getSnapshot } from "../metrics";

import {
  appConfig,
  setConfig,
  getActiveTelegramAccount,
  getTelegramAccounts,
  addTelegramAccount,
  updateTelegramAccount,
  removeTelegramAccount,
  setActiveTelegramAccount,
} from "../config";
import { loadPersistedState } from "../persistence";
import { availableJsonFiles } from "../llm/personas/personalities";

const app: Express = express();
const PORT = 8080;

export function startWebServer(): void {
  // Serve static files from the 'public' directory
  app.use(express.static(path.join(__dirname, "../../public")));

  // Add JSON body parser middleware
  app.use(express.json());

  function migrateAccountFromEnv(): boolean {
    const apiIdRaw = process.env.API_ID;
    const apiHashRaw = process.env.API_HASH;
    if (!apiIdRaw || !apiHashRaw) {
      return false;
    }

    const apiId = Number(apiIdRaw);
    if (!Number.isFinite(apiId)) {
      console.warn("Skipping Telegram credential migration: API_ID must be numeric.");
      return false;
    }

    try {
      const label = (process.env.TELEGRAM_ACCOUNT_LABEL || "Migrated Account").trim() || "Migrated Account";
      const sessionString = (process.env.SESSION_STRING || "").trim();
      const account = addTelegramAccount({
        label,
        apiId: Math.trunc(apiId),
        apiHash: apiHashRaw.trim(),
        sessionString,
      });
      setActiveTelegramAccount(account.id);
      console.log("Migrated Telegram credentials from environment variables into dashboard configuration.");
      return true;
    } catch (error) {
      console.warn(
        "Failed to migrate Telegram account from environment variables:",
        (error as any)?.message || error,
      );
      return false;
    }
  }

  type AccountView = ReturnType<typeof getTelegramAccounts>[number];
  const decorateAccount = (account: AccountView) => ({
    ...account,
    isActive: appConfig().activeAccountId === account.id,
  });

  // Redact sensitive fields (apiHash, sessionString) from responses
  const sanitizeAccount = (account: AccountView) => {
    const { id, label, apiId, createdAt, updatedAt } = account;
    return {
      id,
      label,
      apiId,
      createdAt,
      updatedAt,
      isActive: appConfig().activeAccountId === id,
      hasSession: typeof account.sessionString === "string" && account.sessionString.trim().length > 0,
    };
  };

  async function applyPersistedConfig() {
    try {
      const persisted = loadPersistedState();
      const allowedProviders = ["pollinations", "openrouter"] as const;
      const updates: Record<string, unknown> = {};

      // Prefer directly persisted systemPrompt to avoid runtime JSON import issues
      if (typeof persisted.systemPrompt === "string" && persisted.systemPrompt.trim().length > 0) {
        updates.systemPrompt = persisted.systemPrompt;
        if (persisted.currentPersona) updates.currentPersona = persisted.currentPersona;
      } else if (persisted.currentPersona && availableJsonFiles.includes(persisted.currentPersona)) {
        try {
          const importedPersona = await import(`../llm/personas/${persisted.currentPersona}`, { with: { type: "json" } }).then(
            (mod) => mod.default,
          );
          updates.systemPrompt = JSON.stringify(importedPersona);
          updates.currentPersona = persisted.currentPersona;
        } catch (e) {
          console.warn("Failed to load persisted persona, falling back:", (e as any)?.message || e);
        }
      }

      if (persisted.llmProvider && allowedProviders.includes(persisted.llmProvider)) {
        updates.llmProvider = persisted.llmProvider;
        if (
          persisted.llmProvider === "openrouter" &&
          typeof persisted.openrouterModel === "string" &&
          persisted.openrouterModel.trim()
        ) {
          updates.openrouterModel = persisted.openrouterModel.trim();
        }
      }

      if (Array.isArray(persisted.telegramAccounts)) {
        updates.telegramAccounts = persisted.telegramAccounts;
      }

      if (Object.prototype.hasOwnProperty.call(persisted, "activeAccountId")) {
        updates.activeAccountId = persisted.activeAccountId ?? null;
      }

      if (Object.keys(updates).length > 0) {
        setConfig(updates as Partial<ReturnType<typeof appConfig>>);
      }

      if (getTelegramAccounts().length === 0) {
        const migrated = migrateAccountFromEnv();
        if (!migrated && (process.env.API_ID || process.env.API_HASH || process.env.SESSION_STRING)) {
          console.warn(
            "Telegram credentials were detected in environment variables, but no account is configured. Add an account via the dashboard.",
          );
        }
      }
    } catch (e) {
      console.warn('Failed to apply persisted state at startup:', (e as any)?.message || e);
    }
  }

  app.get("/api/status", (req: Request, res: Response) => {
    res.json(getStatus());
  });

  app.get("/api/metrics", (req: Request, res: Response) => {
    res.json(getSnapshot());
  });

  app.get("/api/telegram/groups", async (req: Request, res: Response) => {
    try {
      const groups = await listTelegramGroups();
      res.json({ success: true, groups });
    } catch (error) {
      const message = (error as any)?.message || "Failed to load group list.";
      const status = message.includes("not running") ? 409 : 500;
      res.status(status).json({ success: false, message });
    }
  });

  app.get("/api/telegram/groups/:groupId/messages", async (req: Request, res: Response) => {
    const { groupId } = req.params;
    const rawLimit = req.query.limit;
    const parsedLimit = typeof rawLimit === "string" ? Number.parseInt(rawLimit, 10) : undefined;

    if (!groupId) {
      return res.status(400).json({ success: false, message: "Group ID is required." });
    }

    try {
      const history = await getGroupChatHistory(groupId, parsedLimit);
      res.json(history);
    } catch (error) {
      const message = (error as any)?.message || "Failed to load chat history.";
      const status = message.includes("not running") ? 409 : 404;
      res.status(status).json({ success: false, message });
    }
  });

  app.post("/api/telegram/groups/:groupId/messages", async (req: Request, res: Response) => {
    const { groupId } = req.params;
    const { text } = req.body || {};

    if (!groupId) {
      return res.status(400).json({ success: false, message: "Group ID is required." });
    }

    const result = await sendMessageToGroup(groupId, typeof text === "string" ? text : "");
    const status = result.success
      ? 201
      : result.message.includes("not running")
        ? 409
        : result.message.includes("not accessible") || result.message.includes("required")
          ? 400
          : 500;
    res.status(status).json(result);
  });

  app.post("/api/telegram/groups/:groupId/sentiment", async (req: Request, res: Response) => {
    const { groupId } = req.params;
    if (!groupId) {
      return res.status(400).json({ success: false, message: "Group ID is required." });
    }

    const result = await sendSentimentToGroup(groupId);
    const status = result.success
      ? 201
      : result.message.includes("not running")
        ? 409
        : 500;
    res.status(status).json(result);
  });

  app.post("/api/start", async (req: Request, res: Response) => {
    const result = await startBot();
    res.status(result.success ? 200 : 500).json(result);
  });

  app.post("/api/stop", async (req: Request, res: Response) => {
    const result = await stopBot();
    res.status(result.success ? 200 : 500).json(result);
  });

  app.post("/api/config/persona", async (req: Request, res: Response) => {
    const { persona } = req.body;
    const availablePersonalities = availableJsonFiles;


    if (!persona || typeof persona !== "string" || !availablePersonalities.includes(persona)) {
      return res.status(400).json({ success: false, message: "Invalid persona." });
    }
    const importedPersona = await import(`../llm/personas/${persona}`, { with: { type: "json" } }).then(mod => mod.default);
    setConfig({
      systemPrompt: JSON.stringify(importedPersona),
      currentPersona: persona,
    } as Partial<ReturnType<typeof appConfig>>);
    res.status(201).json({ success: true, persona });
  });

  app.get("/api/config/accounts", (req: Request, res: Response) => {
    const accounts = getTelegramAccounts();
    const activeAccountId = appConfig().activeAccountId ?? null;
    res.json({
      accounts: accounts.map((account) => sanitizeAccount(account as any)),
      activeAccountId,
    });
  });

  app.post("/api/config/accounts", (req: Request, res: Response) => {
    const { label, apiId, apiHash, sessionString } = req.body || {};
    try {
      const account = addTelegramAccount({
        label: typeof label === "string" ? label : String(label ?? ""),
        apiId: typeof apiId === "number" ? apiId : Number(apiId),
        apiHash: typeof apiHash === "string" ? apiHash : apiHash != null ? String(apiHash) : "",
        sessionString:
          typeof sessionString === "string"
            ? sessionString
            : sessionString != null
              ? String(sessionString)
              : undefined,
      });
      res.status(201).json({
        success: true,
        account: sanitizeAccount(account as any),
        activeAccountId: appConfig().activeAccountId ?? null,
      });
    } catch (error) {
      const message = (error as any)?.message || "Failed to add account.";
      res.status(400).json({ success: false, message });
    }
  });

  app.put("/api/config/accounts/:id", (req: Request, res: Response) => {
    const { id } = req.params;
    const { label, apiId, apiHash, sessionString } = req.body || {};
    const patch: Record<string, unknown> = {};
    if (label !== undefined) {
      patch.label = typeof label === "string" ? label : String(label ?? "");
    }
    if (apiId !== undefined) {
      patch.apiId = typeof apiId === "number" ? apiId : Number(apiId);
    }
    if (apiHash !== undefined) {
      patch.apiHash = typeof apiHash === "string" ? apiHash : apiHash != null ? String(apiHash) : "";
    }
    if (sessionString !== undefined) {
      patch.sessionString =
        typeof sessionString === "string"
          ? sessionString
          : sessionString != null
            ? String(sessionString)
            : "";
    }

    try {
      const account = updateTelegramAccount(id, patch);
      res.json({
        success: true,
        account: sanitizeAccount(account as any),
        activeAccountId: appConfig().activeAccountId ?? null,
      });
    } catch (error) {
      const message = (error as any)?.message || "Failed to update account.";
      const status = message.toLowerCase().includes("not found") ? 404 : 400;
      res.status(status).json({ success: false, message });
    }
  });

  app.delete("/api/config/accounts/:id", (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      removeTelegramAccount(id);
      res.json({
        success: true,
        accounts: getTelegramAccounts().map((account) => sanitizeAccount(account as any)),
        activeAccountId: appConfig().activeAccountId ?? null,
      });
    } catch (error) {
      const message = (error as any)?.message || "Failed to remove account.";
      const status = message.toLowerCase().includes("not found") ? 404 : 400;
      res.status(status).json({ success: false, message });
    }
  });

  app.post("/api/config/accounts/:id/activate", async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      // Enforce: only accounts with a session string can be set active
      const existing = getTelegramAccounts().find((a) => a.id === id);
      if (!existing) {
        return res.status(404).json({ success: false, message: "Account not found." });
      }
      const hasSession = typeof existing.sessionString === "string" && existing.sessionString.trim().length > 0;
      if (!hasSession) {
        return res.status(400).json({ success: false, message: "Cannot activate account without a session. Start console login first." });
      }

      const account = setActiveTelegramAccount(id);

      // If bot is running, restart it with the newly active account (non-interactive)
      let restarted = false;
      let restartMessage = "";
      try {
        if (getStatus().isRunning) {
          const stop = await stopBot();
          if (!stop.success) {
            restartMessage = stop.message || "Failed to stop bot.";
          }
          const start = await startBotNonInteractive();
          restarted = start.success === true;
          restartMessage = start.message || restartMessage;
        }
      } catch (e: any) {
        restartMessage = e?.message || String(e);
      }

      res.json({
        success: true,
        account: sanitizeAccount(account as any),
        activeAccountId: appConfig().activeAccountId ?? null,
        restarted,
        restartMessage,
      });
    } catch (error) {
      const message = (error as any)?.message || "Failed to activate account.";
      const status = message.toLowerCase().includes("not found") ? 404 : 400;
      res.status(status).json({ success: false, message });
    }
  });

  // Initiate interactive console login for a specific account (non-blocking)
  app.post("/api/config/accounts/:id/login", async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ success: false, message: "Account ID is required." });
    }
    try {
      const result = await initiateAccountConsoleLogin(id);
      const status = result.success ? 202 : 400;
      res.status(status).json(result);
    } catch (error) {
      const message = (error as any)?.message || "Failed to initiate console login.";
      res.status(500).json({ success: false, message });
    }
  });

  app.get("/api/config/personas", async (req: Request, res: Response) => {
    const cfg = appConfig() as any;
    const availablePersonalities = availableJsonFiles;
    res.json({ available: availablePersonalities, current: cfg.currentPersona || 'granny.json' });
  });

  // LLM provider + model configuration
  app.get("/api/config/llm", async (req: Request, res: Response) => {
    const cfg = appConfig() as any;
    const hasOpenrouterKey = !!(process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.trim());
    // A small curated list of common OpenRouter models (can be extended)
    const availableOpenRouterModels = [
      "google/gemini-2.0-flash-001",
      "google/gemini-2.5-flash-lite-preview-09-2025",
      "mistralai/mistral-nemo",
    ];
    res.json({
      provider: cfg.llmProvider || 'pollinations',
      openrouterModel: cfg.openrouterModel || 'google/gemini-2.0-flash-001',
      hasOpenrouterKey,
      availableOpenRouterModels,
    });
  });

  app.post("/api/config/llm", async (req: Request, res: Response) => {
    const { provider, openrouterModel } = req.body || {};
    const allowedProviders = ["pollinations", "openrouter"];
    if (!allowedProviders.includes(provider)) {
      return res.status(400).json({ success: false, message: "Invalid provider" });
    }
    const updates: Partial<ReturnType<typeof appConfig>> = { llmProvider: provider };
    if (provider === 'openrouter') {
      if (typeof openrouterModel === 'string' && openrouterModel.trim().length > 0) {
        updates.openrouterModel = openrouterModel.trim();
      }
    }
    setConfig(updates);
    const cfg = appConfig() as any;
    res.status(201).json({ success: true, provider: cfg.llmProvider, openrouterModel: cfg.openrouterModel });
  });

  app.listen(PORT, async () => {
    console.log(`Web interface running at http://localhost:${PORT}`);

    // Ensure persisted state is applied before any auto-start
    await applyPersistedConfig();

    // Attempt to auto-start the bot if a valid session is present.
    const activeAccount = getActiveTelegramAccount();
    if (!activeAccount) {
      console.log("Auto-start skipped: no active Telegram account configured.");
    } else if (activeAccount.sessionString && activeAccount.sessionString.trim()) {
      try {
        const result = await startBotNonInteractive();
        if (result.success) {
          console.log("Auto-start: bot is running using existing session.");
        } else {
          console.log(result.message);
        }
      } catch (err: any) {
        console.log("Auto-start failed:", err?.message || String(err));
      }
    } else {
      console.log(
        `Auto-start skipped: active account "${activeAccount.label}" does not have a stored session string. Start the bot once manually to capture it.`,
      );
    }
  });
}
