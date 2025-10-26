// src/web/server.ts
import express, { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import path from "node:path";
import {
  startBot,
  stopBot,
  getStatus,
  startBotNonInteractive,
  listTelegramGroups,
  sendSentimentToGroup,
  listChats,
  getChatHistory,
  sendMessageToChat,
  sendBlendMessage,
  initiateAccountConsoleLogin,
} from "../telegram/client";
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
import { availableJsonFiles } from "../llm/personalities";
import {
  updateChatPersona as setChatPersonaForChat,
  resetChatPersonaToDefault as resetChatPersonaForChat,
} from "../telegram/chatPersonality";
import { loadPersonaFile } from "../utils/personaLoader";

const app: Express = express();
const PORT = 8080;

// Rate limiter for general API endpoints
// 1000 requests per 15 minutes per IP (allows frequent dashboard polling/updates)
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 1000 requests per windowMs
  message: {
    success: false,
    message: "Too many requests from this IP, please try again later."
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

// Stricter rate limiter for sensitive endpoints (auth, config updates)
// 50 requests per 15 minutes per IP (allows multiple config changes without hitting limit)
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 50 requests per windowMs
  message: {
    success: false,
    message: "Too many requests to this sensitive endpoint, please try again later."
  },
  standardHeaders: true,
  legacyHeaders: false,
});

export function startWebServer(): void {
  // Serve static files from the project 'public' directory (works in dev and prod)
  app.use(express.static(path.join(process.cwd(), "public")));

  // Add JSON body parser middleware
  app.use(express.json());

  // Apply general rate limiter to all API routes
  app.use("/api/", generalLimiter);

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
      const persisted = await loadPersistedState();
      const allowedProviders = ["pollinations", "openrouter"] as const;
      const updates: Record<string, unknown> = {};

      // Prefer directly persisted systemPrompt to avoid runtime JSON import issues
      if (typeof persisted.systemPrompt === "string" && persisted.systemPrompt.trim().length > 0) {
        updates.systemPrompt = persisted.systemPrompt;
        if (persisted.currentPersona) updates.currentPersona = persisted.currentPersona;
      } else if (persisted.currentPersona && availableJsonFiles.includes(persisted.currentPersona)) {
        try {
          // Use shared persona loader utility for consistent error handling
          const personaPrompt = await loadPersonaFile(persisted.currentPersona);
          updates.systemPrompt = personaPrompt;
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

      if (typeof (persisted as any).openrouterApiKey === 'string' && (persisted as any).openrouterApiKey.trim()) {
        (updates as any).openrouterApiKey = (persisted as any).openrouterApiKey.trim();
      }

      if (Array.isArray(persisted.telegramAccounts)) {
        updates.telegramAccounts = persisted.telegramAccounts;
      }

      if (Object.hasOwn(persisted, "activeAccountId")) {
        updates.activeAccountId = persisted.activeAccountId ?? null;
      }

      if (typeof (persisted as any).humanEscalationChatId === "string") {
        updates.humanEscalationChatId = (persisted as any).humanEscalationChatId;
      }

      // Load supervisor config if present
      if (persisted.supervisor && typeof persisted.supervisor === 'object') {
        updates.supervisor = persisted.supervisor;
      }

      // Load messageDelays config if present
      if (persisted.messageDelays && typeof persisted.messageDelays === 'object') {
        updates.messageDelays = persisted.messageDelays;
      }

      if (Object.keys(updates).length > 0) {
        setConfig(updates as Partial<ReturnType<typeof appConfig>>);
      }

      // Migration: if legacy humanEscalationChatId exists but supervisor.contact doesn't, migrate it
      const currentCfg = appConfig() as any;
      const legacyContact = (persisted as any).humanEscalationChatId;
      if (legacyContact && typeof legacyContact === 'string' && legacyContact.trim()) {
        if (!currentCfg.supervisor?.contact?.trim()) {
          console.log("Migrating legacy humanEscalationChatId to supervisor.contact");
          setConfig({
            supervisor: { contact: legacyContact.trim() }
          } as any);
        }
      }

      // One-time migration: if env key is set and not yet in config, store it
      const cfg = appConfig() as any;
      const envKey = (process.env.OPENROUTER_API_KEY || '').trim();
      if (!cfg.openrouterApiKey && envKey) {
        setConfig({ openrouterApiKey: envKey } as any);
        // Sanitize config data in logs to prevent exposure of sensitive information
        console.log("Migrated OPENROUTER_API_KEY from environment to persisted configuration.");
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

  app.post("/api/telegram/groups/:groupId/sentiment", async (req: Request, res: Response) => {
    const { groupId } = req.params;
    if (!groupId) {
      return res.status(400).json({ success: false, message: "Group ID is required." });
    }

    const result = await sendSentimentToGroup(groupId);
    let status: number;
    if (result.success) {
      status = 201;
    } else if (result.message.includes("not running")) {
      status = 409;
    } else {
      status = 500;
    }
    res.status(status).json(result);
  });

  app.get("/api/chats", async (req: Request, res: Response) => {
    try {
      const chats = await listChats();
      res.json({ success: true, chats });
    } catch (error) {
      const message = (error as any)?.message || "Failed to load chats.";
      const status = message.includes("not running") ? 409 : 500;
      res.status(status).json({ success: false, message });
    }
  });

  app.get("/api/chats/:chatId", async (req: Request, res: Response) => {
    const { chatId } = req.params;
    if (!chatId) {
      return res.status(400).json({ success: false, message: "Chat ID is required." });
    }

    try {
      const history = await getChatHistory(chatId);
      res.json({ success: true, ...history });
    } catch (error) {
      const message = (error as any)?.message || "Failed to load chat history.";
      const lowered = message.toLowerCase();
      let status: number;
      if (lowered.includes("not running")) {
        status = 409;
      } else if (lowered.includes("not found")) {
        status = 404;
      } else {
        status = 500;
      }
      res.status(status).json({ success: false, message });
    }
  });

  app.post("/api/chats/:chatId/messages", async (req: Request, res: Response) => {
    const { chatId } = req.params;
    const { message } = req.body || {};

    if (!chatId) {
      return res.status(400).json({ success: false, message: "Chat ID is required." });
    }

    let text: string;
    if (typeof message === "string") {
      text = message;
    } else if (message == null) {
      text = "";
    } else {
      text = String(message);
    }
    if (!text.trim()) {
      return res.status(400).json({ success: false, message: "Message text is required." });
    }

    const result = await sendMessageToChat(chatId, text);
    const lowered = result.message.toLowerCase();
    let status: number;
    if (result.success) {
      status = 201;
    } else if (lowered.includes("not running")) {
      status = 409;
    } else if (lowered.includes("not found")) {
      status = 404;
    } else {
      status = 400;
    }
    res.status(status).json(result);
  });

  app.post("/api/chats/:chatId/personality", async (req: Request, res: Response) => {
    const { chatId } = req.params;
    const personaRaw = req.body?.persona;

    if (!chatId) {
      return res.status(400).json({ success: false, message: "Chat ID is required." });
    }

    let personaId: string;
    if (typeof personaRaw === "string") {
      personaId = personaRaw.trim();
    } else if (personaRaw == null) {
      personaId = "";
    } else {
      personaId = String(personaRaw).trim();
    }
    if (!personaId) {
      return res.status(400).json({ success: false, message: "Persona identifier is required." });
    }

    try {
      const { summary } = await setChatPersonaForChat(chatId, personaId);
      res.json({
        success: true,
        message: `Chat persona updated to ${summary.personaLabel}.`,
        persona: summary,
      });
    } catch (error) {
      const message = (error as any)?.message || "Failed to update chat persona.";
      const lowered = message.toLowerCase();
      const status = lowered.includes("persona") || lowered.includes("available") ? 400 : 500;
      res.status(status).json({ success: false, message });
    }
  });

  app.delete("/api/chats/:chatId/personality", async (req: Request, res: Response) => {
    const { chatId } = req.params;
    if (!chatId) {
      return res.status(400).json({ success: false, message: "Chat ID is required." });
    }

    try {
      const { summary } = await resetChatPersonaForChat(chatId);
      res.json({
        success: true,
        message: `Chat persona reset to ${summary.personaLabel}.`,
        persona: summary,
      });
    } catch (error) {
      const message = (error as any)?.message || "Failed to reset chat persona.";
      res.status(500).json({ success: false, message });
    }
  });

  app.post("/api/chats/:chatId/blend", async (req: Request, res: Response) => {
    const { chatId } = req.params;
    if (!chatId) {
      return res.status(400).json({ success: false, message: "Chat ID is required." });
    }

    const result = await sendBlendMessage(chatId);
    const lowered = (result.message || "").toLowerCase();
    let status: number;
    if (result.success) {
      status = 201;
    } else if (lowered.includes("not running")) {
      status = 409;
    } else if (lowered.includes("not found")) {
      status = 404;
    } else {
      status = 400;
    }
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

  app.post("/api/config/persona", strictLimiter, async (req: Request, res: Response) => {
    const { persona } = req.body;
    const availablePersonalities = availableJsonFiles;


    if (!persona || typeof persona !== "string" || !availablePersonalities.includes(persona)) {
      return res.status(400).json({ success: false, message: "Invalid persona." });
    }
    
    try {
      // Use shared persona loader utility for consistent error handling
      const personaPrompt = await loadPersonaFile(persona);
      setConfig({
        systemPrompt: personaPrompt,
        currentPersona: persona,
      } as Partial<ReturnType<typeof appConfig>>);
      res.status(201).json({ success: true, persona });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load persona.";
      res.status(500).json({ success: false, message });
    }
  });

  app.get("/api/config/accounts", (req: Request, res: Response) => {
    const accounts = getTelegramAccounts();
    const activeAccountId = appConfig().activeAccountId ?? null;
    res.json({
      accounts: accounts.map((account) => sanitizeAccount(account as any)),
      activeAccountId,
    });
  });

  app.post("/api/config/accounts", strictLimiter, (req: Request, res: Response) => {
    const { label, apiId, apiHash, sessionString } = req.body || {};
    try {
      let processedApiHash: string;
      if (typeof apiHash === "string") {
        processedApiHash = apiHash;
      } else if (apiHash == null) {
        processedApiHash = "";
      } else {
        processedApiHash = String(apiHash);
      }
      const account = addTelegramAccount({
        label: typeof label === "string" ? label : String(label ?? ""),
        apiId: typeof apiId === "number" ? apiId : Number(apiId),
        apiHash: processedApiHash,
        sessionString: (() => {
          if (typeof sessionString === "string") {
            return sessionString;
          } else if (sessionString == null) {
            return undefined;
          } else {
            return String(sessionString);
          }
        })(),
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

  app.put("/api/config/accounts/:id", strictLimiter, (req: Request, res: Response) => {
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
      let processedApiHash: string;
      if (typeof apiHash === "string") {
        processedApiHash = apiHash;
      } else if (apiHash == null) {
        processedApiHash = "";
      } else {
        processedApiHash = String(apiHash);
      }
      patch.apiHash = processedApiHash;
    }
    if (sessionString !== undefined) {
      if (typeof sessionString === "string") {
        patch.sessionString = sessionString;
      } else if (sessionString == null) {
        patch.sessionString = "";
      } else {
        patch.sessionString = String(sessionString);
      }
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

  app.delete("/api/config/accounts/:id", strictLimiter, (req: Request, res: Response) => {
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

  app.post("/api/config/accounts/:id/activate", strictLimiter, async (req: Request, res: Response) => {
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
  app.post("/api/config/accounts/:id/login", strictLimiter, async (req: Request, res: Response) => {
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
    const hasOpenrouterKey = !!(cfg.openrouterApiKey && String(cfg.openrouterApiKey).trim());
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

  app.post("/api/config/llm", strictLimiter, async (req: Request, res: Response) => {
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

  // Manage OpenRouter API key (never returns the key value)
  app.post("/api/config/llm/key", strictLimiter, async (req: Request, res: Response) => {
    const { key } = req.body || {};
    const next = (typeof key === 'string' ? key : '').trim();
    setConfig({ openrouterApiKey: next } as any);
    const cfg = appConfig() as any;
    res.status(201).json({ success: true, hasOpenrouterKey: !!cfg.openrouterApiKey?.trim() });
  });

  // New supervisor configuration endpoints
  app.get("/api/config/supervisor", (req: Request, res: Response) => {
    const cfg = appConfig() as any;
    const supervisor = cfg.supervisor || {
      mode: 'wake-up',
      contact: '',
      wakeUpDelayMs: { min: 5000, max: 10000 },
      alwaysFallbackDelayMs: { min: 30000, max: 60000 },
      sleepThresholdMs: 1000
    };
    res.json({
      mode: supervisor.mode,
      contact: supervisor.contact,
      wakeUpDelayMs: supervisor.wakeUpDelayMs,
      alwaysFallbackDelayMs: supervisor.alwaysFallbackDelayMs,
      sleepThresholdMs: supervisor.sleepThresholdMs
    });
  });

  app.post("/api/config/supervisor", strictLimiter, (req: Request, res: Response) => {
    const { mode, contact, wakeUpDelayMs, alwaysFallbackDelayMs, sleepThresholdMs } = req.body || {};
    
    try {
      const updates: any = {};
      
      if (mode !== undefined) {
        updates.mode = mode;
      }
      if (contact !== undefined) {
        if (typeof contact === "string") {
          updates.contact = contact.trim();
        } else if (contact == null) {
          updates.contact = "";
        } else {
          updates.contact = String(contact).trim();
        }
      }
      if (wakeUpDelayMs !== undefined) {
        updates.wakeUpDelayMs = wakeUpDelayMs;
      }
      if (alwaysFallbackDelayMs !== undefined) {
        updates.alwaysFallbackDelayMs = alwaysFallbackDelayMs;
      }
      if (sleepThresholdMs !== undefined) {
        updates.sleepThresholdMs = sleepThresholdMs;
      }
      
      // Apply updates through setConfig which will validate
      setConfig({ supervisor: updates } as any);
      
      // Return updated config
      const cfg = appConfig() as any;
      const supervisor = cfg.supervisor;
      res.status(201).json({
        success: true,
        mode: supervisor.mode,
        contact: supervisor.contact,
        wakeUpDelayMs: supervisor.wakeUpDelayMs,
        alwaysFallbackDelayMs: supervisor.alwaysFallbackDelayMs,
        sleepThresholdMs: supervisor.sleepThresholdMs
      });
    } catch (error) {
      const message = (error as any)?.message || "Failed to update supervisor configuration.";
      res.status(400).json({ success: false, message });
    }
  });

  // Legacy escalation endpoints - now read/write both supervisor.contact and humanEscalationChatId
  app.get("/api/config/escalation", (req: Request, res: Response) => {
    const cfg = appConfig() as any;
    // Prefer supervisor.contact, fallback to legacy field
    const contact = cfg?.supervisor?.contact || cfg?.humanEscalationChatId || "";
    res.json({ contact });
  });

  app.post("/api/config/escalation", strictLimiter, (req: Request, res: Response) => {
    const { contact } = req.body || {};
    let next: string;
    if (typeof contact === "string") {
      next = contact.trim();
    } else if (contact == null) {
      next = "";
    } else {
      next = String(contact).trim();
    }
    
    // Update both fields for backward compatibility
    setConfig({
      humanEscalationChatId: next,
      supervisor: { contact: next }
    } as any);
    
    const cfg = appConfig() as any;
    const updatedContact = cfg?.supervisor?.contact || cfg?.humanEscalationChatId || "";
    res.status(201).json({ success: true, contact: updatedContact });
  });

  // Message delays configuration endpoints
  app.get("/api/config/message-delays", (req: Request, res: Response) => {
    const cfg = appConfig() as any;
    const messageDelays = cfg.messageDelays || {
      waitBeforeTypingMs: { min: 5000, max: 10000 },
      typingDurationMs: { min: 5000, max: 10000 },
      typingKeepaliveMs: 4000
    };
    res.json({
      waitBeforeTypingMs: messageDelays.waitBeforeTypingMs,
      typingDurationMs: messageDelays.typingDurationMs,
      typingKeepaliveMs: messageDelays.typingKeepaliveMs
    });
  });

  app.post("/api/config/message-delays", strictLimiter, (req: Request, res: Response) => {
    const { waitBeforeTypingMs, typingDurationMs, typingKeepaliveMs } = req.body || {};
    
    try {
      const updates: any = {};
      
      // Validate waitBeforeTypingMs
      if (waitBeforeTypingMs !== undefined) {
        if (typeof waitBeforeTypingMs !== 'object' ||
            typeof waitBeforeTypingMs.min !== 'number' ||
            typeof waitBeforeTypingMs.max !== 'number') {
          return res.status(400).json({
            success: false,
            message: 'waitBeforeTypingMs must have numeric min and max values'
          });
        }
        if (waitBeforeTypingMs.min < 0 || waitBeforeTypingMs.max < 0) {
          return res.status(400).json({
            success: false,
            message: 'waitBeforeTypingMs min and max must be non-negative'
          });
        }
        if (waitBeforeTypingMs.min > waitBeforeTypingMs.max) {
          return res.status(400).json({
            success: false,
            message: 'waitBeforeTypingMs min cannot be greater than max'
          });
        }
        updates.waitBeforeTypingMs = waitBeforeTypingMs;
      }
      
      // Validate typingDurationMs
      if (typingDurationMs !== undefined) {
        if (typeof typingDurationMs !== 'object' ||
            typeof typingDurationMs.min !== 'number' ||
            typeof typingDurationMs.max !== 'number') {
          return res.status(400).json({
            success: false,
            message: 'typingDurationMs must have numeric min and max values'
          });
        }
        if (typingDurationMs.min < 0 || typingDurationMs.max < 0) {
          return res.status(400).json({
            success: false,
            message: 'typingDurationMs min and max must be non-negative'
          });
        }
        if (typingDurationMs.min > typingDurationMs.max) {
          return res.status(400).json({
            success: false,
            message: 'typingDurationMs min cannot be greater than max'
          });
        }
        updates.typingDurationMs = typingDurationMs;
      }
      
      // Validate typingKeepaliveMs
      if (typingKeepaliveMs !== undefined) {
        if (typeof typingKeepaliveMs !== 'number') {
          return res.status(400).json({
            success: false,
            message: 'typingKeepaliveMs must be a number'
          });
        }
        if (typingKeepaliveMs < 0) {
          return res.status(400).json({
            success: false,
            message: 'typingKeepaliveMs must be non-negative'
          });
        }
        if (typingKeepaliveMs >= 5000) {
          return res.status(400).json({
            success: false,
            message: 'typingKeepaliveMs must be less than 5000ms (Telegram requirement)'
          });
        }
        updates.typingKeepaliveMs = typingKeepaliveMs;
      }
      
      // Apply updates through setConfig
      setConfig({ messageDelays: updates } as any);
      
      // Return updated config
      const cfg = appConfig() as any;
      const messageDelays = cfg.messageDelays;
      res.status(201).json({
        success: true,
        waitBeforeTypingMs: messageDelays.waitBeforeTypingMs,
        typingDurationMs: messageDelays.typingDurationMs,
        typingKeepaliveMs: messageDelays.typingKeepaliveMs
      });
    } catch (error) {
      const message = (error as any)?.message || "Failed to update message delays configuration.";
      res.status(400).json({ success: false, message });
    }
  });

  app.listen(PORT, async () => {
    console.log(`Web interface running at http://localhost:${PORT}`);

    // Ensure persisted state is applied before any auto-start
    await applyPersistedConfig();

    // Attempt to auto-start the bot if a valid session is present.
    const activeAccount = getActiveTelegramAccount();
    if (!activeAccount) {
      console.log("Auto-start skipped: no active Telegram account configured.");
    } else if (activeAccount.sessionString?.trim()) {
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
