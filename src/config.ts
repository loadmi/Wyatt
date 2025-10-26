// src/config.ts
// Centralized application configuration and simple helpers
import granny from "./llm/personas/granny.json";

type NumRange = { min: number; max: number };

export type SupervisorMode = 'wake-up' | 'always' | 'disabled';

export interface SupervisorConfig {
  mode: SupervisorMode;
  contact: string;
  wakeUpDelayMs: NumRange;
  alwaysFallbackDelayMs: NumRange;
  sleepThresholdMs: number;
}

export interface MessageDelaysConfig {
  waitBeforeTypingMs: NumRange;
  typingDurationMs: NumRange;
  typingKeepaliveMs: number;
}

export interface HistoryCacheConfig {
  maxMessagesPerChat: number;
  maxCachedChats: number;
}

export interface TelegramAccount {
  id: string;
  label: string;
  apiId: number;
  apiHash: string;
  sessionString: string;
  createdAt: number;
  updatedAt: number;
}

export type TelegramAccountInput = {
  label: string;
  apiId: number;
  apiHash: string;
  sessionString?: string;
};

export type TelegramAccountPatch = Partial<TelegramAccountInput> & {
  sessionString?: string;
};

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  systemPrompt: JSON.stringify(granny),
  // Track currently selected persona filename for dashboard persistence
  currentPersona: "granny.json",
  // LLM provider configuration (persisted; defaults used on first run)
  llmProvider: "openrouter" as "pollinations" | "openrouter",
  openrouterModel: "google/gemini-2.0-flash-001",
  // Secret managed via dashboard and persisted locally
  openrouterApiKey: "",
  telegramAccounts: [] as TelegramAccount[],
  activeAccountId: null as string | null,
  // DEPRECATED: Use supervisor.contact instead. Kept for backward compatibility during migration.
  humanEscalationChatId: "",
  supervisor: {
    mode: 'wake-up' as SupervisorMode,
    contact: '',
    wakeUpDelayMs: {
      min: envNumber("WAKE_UP_DELAY_MS_MIN", 5_000),
      max: envNumber("WAKE_UP_DELAY_MS_MAX", 10_000),
    },
    alwaysFallbackDelayMs: {
      min: envNumber("ALWAYS_FALLBACK_DELAY_MS_MIN", 30_000),
      max: envNumber("ALWAYS_FALLBACK_DELAY_MS_MAX", 60_000),
    },
    sleepThresholdMs: envNumber("SLEEP_THRESHOLD_MS", 300_000),
  } as SupervisorConfig,
  messageDelays: {
    waitBeforeTypingMs: {
      min: envNumber("WAIT_BEFORE_TYPING_MS_MIN", 5_000),
      max: envNumber("WAIT_BEFORE_TYPING_MS_MAX", 10_000),
    },
    typingDurationMs: {
      min: envNumber("TYPING_DURATION_MS_MIN", 5_000),
      max: envNumber("TYPING_DURATION_MS_MAX", 10_000),
    },
    typingKeepaliveMs: envNumber("TYPING_KEEPALIVE_MS", 4_000),
  } as MessageDelaysConfig,
  historyCache: {
    maxMessagesPerChat: envNumber("MAX_MESSAGES_PER_CHAT", 500),
    maxCachedChats: envNumber("MAX_CACHED_CHATS", 100),
  } as HistoryCacheConfig,
};

export const appConfig = () => config;

function cloneAccount(account: TelegramAccount): TelegramAccount {
  return { ...account };
}

function generateAccountId(): string {
  return `acct_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizePersistedAccount(raw: any): TelegramAccount | null {
  if (!raw || typeof raw !== "object") return null;
  const apiId = Number((raw as any).apiId);
  const apiHash = typeof (raw as any).apiHash === "string" ? (raw as any).apiHash.trim() : "";
  if (!Number.isFinite(apiId) || !apiHash) {
    return null;
  }

  const labelRaw = typeof (raw as any).label === "string" ? (raw as any).label.trim() : "";
  const idRaw = typeof (raw as any).id === "string" ? (raw as any).id.trim() : "";
  const sessionRaw = typeof (raw as any).sessionString === "string" ? (raw as any).sessionString.trim() : "";
  const createdAtRaw = Number((raw as any).createdAt);
  const updatedAtRaw = Number((raw as any).updatedAt);
  const now = Date.now();

  return {
    id: idRaw || generateAccountId(),
    label: labelRaw || "Telegram Account",
    apiId: Math.trunc(apiId),
    apiHash,
    sessionString: sessionRaw,
    createdAt: Number.isFinite(createdAtRaw) ? createdAtRaw : now,
    updatedAt: Number.isFinite(updatedAtRaw) ? updatedAtRaw : now,
  };
}

function ensureActiveAccountConsistency(): void {
  if (
    config.activeAccountId &&
    config.telegramAccounts.some((account) => account.id === config.activeAccountId)
  ) {
    return;
  }

  config.activeAccountId = config.telegramAccounts.length > 0 ? config.telegramAccounts[0].id : null;
}

function persistConfig(): void {
  ensureActiveAccountConsistency();
  console.log("Config Updated");
  try {
    const { savePersistedState } = require("./persistence");
    savePersistedState({
      currentPersona: (config as any).currentPersona,
      llmProvider: (config as any).llmProvider,
      openrouterModel: (config as any).openrouterModel,
      openrouterApiKey: (config as any).openrouterApiKey,
      systemPrompt: (config as any).systemPrompt,
      telegramAccounts: config.telegramAccounts.map(cloneAccount),
      activeAccountId: config.activeAccountId,
      humanEscalationChatId: config.humanEscalationChatId,
      supervisor: config.supervisor,
      messageDelays: config.messageDelays,
      historyCache: config.historyCache,
    });
  } catch (e) {
    console.warn("Failed to persist config:", (e as any)?.message || e);
  }
}

export function randomInRange(min: number, max: number): number {
  if (max <= min) return min;
  const span = max - min;
  return Math.floor(min + Math.random() * span);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function validateSupervisorConfig(supervisor: Partial<SupervisorConfig>): void {
  // Validate mode
  if (supervisor.mode !== undefined) {
    const validModes: SupervisorMode[] = ['wake-up', 'always', 'disabled'];
    if (!validModes.includes(supervisor.mode)) {
      throw new Error(`Invalid supervisor mode: ${supervisor.mode}. Must be one of: ${validModes.join(', ')}`);
    }
  }

  // Validate contact - must be non-empty for non-disabled modes
  if (supervisor.contact !== undefined) {
    const contact = (supervisor.contact || '').trim();
    const mode = supervisor.mode || config.supervisor.mode;
    if (mode !== 'disabled' && !contact) {
      throw new Error('Supervisor contact cannot be empty when mode is not disabled');
    }
  }

  // Validate wakeUpDelayMs
  if (supervisor.wakeUpDelayMs !== undefined) {
    const { min, max } = supervisor.wakeUpDelayMs;
    if (typeof min !== 'number' || typeof max !== 'number') {
      throw new Error('wakeUpDelayMs min and max must be numbers');
    }
    if (min < 0 || max < 0) {
      throw new Error('wakeUpDelayMs min and max must be non-negative');
    }
    if (min > max) {
      throw new Error('wakeUpDelayMs min cannot be greater than max');
    }
  }

  // Validate alwaysFallbackDelayMs
  if (supervisor.alwaysFallbackDelayMs !== undefined) {
    const { min, max } = supervisor.alwaysFallbackDelayMs;
    if (typeof min !== 'number' || typeof max !== 'number') {
      throw new Error('alwaysFallbackDelayMs min and max must be numbers');
    }
    if (min < 0 || max < 0) {
      throw new Error('alwaysFallbackDelayMs min and max must be non-negative');
    }
    if (min > max) {
      throw new Error('alwaysFallbackDelayMs min cannot be greater than max');
    }
  }

  // Validate sleepThresholdMs
  if (supervisor.sleepThresholdMs !== undefined) {
    if (typeof supervisor.sleepThresholdMs !== 'number') {
      throw new Error('sleepThresholdMs must be a number');
    }
    if (supervisor.sleepThresholdMs < 0) {
      throw new Error('sleepThresholdMs must be non-negative');
    }
  }
}

export function setConfig(newConfig: Partial<typeof config>): void {
  if (Object.prototype.hasOwnProperty.call(newConfig, "telegramAccounts")) {
    const rawAccounts = (newConfig as any).telegramAccounts;
    if (Array.isArray(rawAccounts)) {
      const sanitized = rawAccounts
        .map((entry) => sanitizePersistedAccount(entry))
        .filter((entry): entry is TelegramAccount => Boolean(entry))
        .map(cloneAccount);
      config.telegramAccounts = sanitized;
    } else if (rawAccounts === undefined) {
      // No change
    } else {
      config.telegramAccounts = [];
    }
  }

  if (Object.prototype.hasOwnProperty.call(newConfig, "activeAccountId")) {
    const idRaw = (newConfig as any).activeAccountId;
    if (typeof idRaw === "string" && idRaw.trim()) {
      config.activeAccountId = idRaw.trim();
    } else if (idRaw === null) {
      config.activeAccountId = null;
    }
  }

  if (Object.prototype.hasOwnProperty.call(newConfig, "humanEscalationChatId")) {
    const raw = (newConfig as any).humanEscalationChatId;
    if (typeof raw === "string") {
      config.humanEscalationChatId = raw.trim();
      // Migrate to supervisor.contact if not already set
      if (!config.supervisor.contact) {
        config.supervisor.contact = raw.trim();
        console.log("Migrated humanEscalationChatId to supervisor.contact");
      }
    } else if (raw == null) {
      config.humanEscalationChatId = "";
    } else {
      config.humanEscalationChatId = String(raw).trim();
      // Migrate to supervisor.contact if not already set
      if (!config.supervisor.contact) {
        config.supervisor.contact = String(raw).trim();
        console.log("Migrated humanEscalationChatId to supervisor.contact");
      }
    }
  }

  // Handle supervisor config updates
  if (Object.prototype.hasOwnProperty.call(newConfig, "supervisor")) {
    const supervisorUpdate = (newConfig as any).supervisor;
    if (supervisorUpdate && typeof supervisorUpdate === 'object') {
      // Validate before applying
      validateSupervisorConfig(supervisorUpdate);
      
      // Apply updates
      if (supervisorUpdate.mode !== undefined) {
        config.supervisor.mode = supervisorUpdate.mode;
      }
      if (supervisorUpdate.contact !== undefined) {
        const contact = typeof supervisorUpdate.contact === 'string'
          ? supervisorUpdate.contact.trim()
          : String(supervisorUpdate.contact || '').trim();
        config.supervisor.contact = contact;
        // Keep legacy field in sync
        config.humanEscalationChatId = contact;
      }
      if (supervisorUpdate.wakeUpDelayMs !== undefined) {
        config.supervisor.wakeUpDelayMs = supervisorUpdate.wakeUpDelayMs;
      }
      if (supervisorUpdate.alwaysFallbackDelayMs !== undefined) {
        config.supervisor.alwaysFallbackDelayMs = supervisorUpdate.alwaysFallbackDelayMs;
      }
      if (supervisorUpdate.sleepThresholdMs !== undefined) {
        config.supervisor.sleepThresholdMs = supervisorUpdate.sleepThresholdMs;
      }
    }
  }

  // Handle messageDelays config updates
  if (Object.prototype.hasOwnProperty.call(newConfig, "messageDelays")) {
    const messageDelaysUpdate = (newConfig as any).messageDelays;
    if (messageDelaysUpdate && typeof messageDelaysUpdate === 'object') {
      if (messageDelaysUpdate.waitBeforeTypingMs !== undefined) {
        config.messageDelays.waitBeforeTypingMs = messageDelaysUpdate.waitBeforeTypingMs;
      }
      if (messageDelaysUpdate.typingDurationMs !== undefined) {
        config.messageDelays.typingDurationMs = messageDelaysUpdate.typingDurationMs;
      }
      if (messageDelaysUpdate.typingKeepaliveMs !== undefined) {
        config.messageDelays.typingKeepaliveMs = messageDelaysUpdate.typingKeepaliveMs;
      }
    }
  }

  // Handle historyCache config updates
  if (Object.prototype.hasOwnProperty.call(newConfig, "historyCache")) {
    const historyCacheUpdate = (newConfig as any).historyCache;
    if (historyCacheUpdate && typeof historyCacheUpdate === 'object') {
      if (historyCacheUpdate.maxMessagesPerChat !== undefined) {
        config.historyCache.maxMessagesPerChat = historyCacheUpdate.maxMessagesPerChat;
      }
      if (historyCacheUpdate.maxCachedChats !== undefined) {
        config.historyCache.maxCachedChats = historyCacheUpdate.maxCachedChats;
      }
    }
  }

  const rest: Partial<typeof config> = { ...newConfig };
  delete (rest as any).telegramAccounts;
  delete (rest as any).activeAccountId;
  delete (rest as any).humanEscalationChatId;
  delete (rest as any).supervisor;
  delete (rest as any).messageDelays;
  delete (rest as any).historyCache;
  Object.assign(config, rest);

  persistConfig();
}

export function getTelegramAccounts(): TelegramAccount[] {
  return config.telegramAccounts.map(cloneAccount);
}

export function getActiveTelegramAccount(): TelegramAccount | undefined {
  ensureActiveAccountConsistency();
  const { activeAccountId } = config;
  if (!activeAccountId) return undefined;
  const found = config.telegramAccounts.find((account) => account.id === activeAccountId);
  return found ? cloneAccount(found) : undefined;
}

function coerceLabel(label: string | undefined): string {
  const trimmed = (label ?? "").trim();
  if (trimmed) return trimmed;
  const fallbackIndex = config.telegramAccounts.length + 1;
  return `Account ${fallbackIndex}`;
}

export function addTelegramAccount(input: TelegramAccountInput): TelegramAccount {
  const apiIdNumber = Number(input.apiId);
  if (!Number.isFinite(apiIdNumber)) {
    throw new Error("API ID must be a number");
  }

  const apiHash = (input.apiHash ?? "").trim();
  if (!apiHash) {
    throw new Error("API hash is required");
  }

  const sessionString = (input.sessionString ?? "").trim();
  const now = Date.now();
  const account: TelegramAccount = {
    id: generateAccountId(),
    label: coerceLabel(input.label),
    apiId: Math.trunc(apiIdNumber),
    apiHash,
    sessionString,
    createdAt: now,
    updatedAt: now,
  };

  config.telegramAccounts = [...config.telegramAccounts, account];
  if (!config.activeAccountId) {
    config.activeAccountId = account.id;
  }

  persistConfig();
  return cloneAccount(account);
}

export function updateTelegramAccount(
  id: string,
  patch: TelegramAccountPatch,
): TelegramAccount {
  const targetId = id.trim();
  if (!targetId) {
    throw new Error("Account ID is required");
  }

  const index = config.telegramAccounts.findIndex((account) => account.id === targetId);
  if (index === -1) {
    throw new Error("Account not found");
  }

  const current = config.telegramAccounts[index];
  const updated: TelegramAccount = { ...current };

  if (patch.label !== undefined) {
    updated.label = coerceLabel(patch.label);
  }

  if (patch.apiId !== undefined) {
    const apiIdNumber = Number(patch.apiId);
    if (!Number.isFinite(apiIdNumber)) {
      throw new Error("API ID must be a number");
    }
    updated.apiId = Math.trunc(apiIdNumber);
  }

  if (patch.apiHash !== undefined) {
    const apiHash = (patch.apiHash ?? "").trim();
    if (!apiHash) {
      throw new Error("API hash is required");
    }
    updated.apiHash = apiHash;
  }

  if (patch.sessionString !== undefined) {
    updated.sessionString = (patch.sessionString ?? "").trim();
  }

  updated.updatedAt = Date.now();

  const nextAccounts = [...config.telegramAccounts];
  nextAccounts[index] = updated;
  config.telegramAccounts = nextAccounts;
  persistConfig();
  return cloneAccount(updated);
}

export function removeTelegramAccount(id: string): void {
  const targetId = id.trim();
  if (!targetId) {
    throw new Error("Account ID is required");
  }

  const filtered = config.telegramAccounts.filter((account) => account.id !== targetId);
  if (filtered.length === config.telegramAccounts.length) {
    throw new Error("Account not found");
  }

  config.telegramAccounts = filtered;
  if (config.activeAccountId === targetId) {
    config.activeAccountId = filtered.length > 0 ? filtered[0].id : null;
  }

  persistConfig();
}

export function setActiveTelegramAccount(id: string): TelegramAccount {
  const targetId = id.trim();
  if (!targetId) {
    throw new Error("Account ID is required");
  }

  const account = config.telegramAccounts.find((entry) => entry.id === targetId);
  if (!account) {
    throw new Error("Account not found");
  }

  config.activeAccountId = account.id;
  persistConfig();
  return cloneAccount(account);
}
