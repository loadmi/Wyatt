import { appConfig } from "../config";
import { loadPersistedState, savePersistedState } from "../persistence";

export type ChatPersonalityRecord = {
  personaId: string | null;
  personaLabel: string;
  systemPrompt: string;
  provider: "pollinations" | "openrouter";
  model?: string | null;
  assignedAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  usageCount?: number;
};

export type ChatPersonalityDescriptor = Omit<ChatPersonalityRecord, "systemPrompt">;

const store = new Map<string, ChatPersonalityRecord>();
let loaded = false;

function formatPersonaLabel(personaId: string | null, fallback?: string): string {
  if (fallback && fallback.trim().length > 0) {
    return fallback.trim();
  }

  if (typeof personaId === "string" && personaId.trim().length > 0) {
    const base = personaId.trim().replace(/\.json$/i, "");
    const cleaned = base.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    if (cleaned.length > 0) {
      return cleaned.replace(/\b([a-z])/gi, (match) => match.toUpperCase());
    }
  }

  return "Custom Personality";
}

function sanitizeRecord(raw: any): ChatPersonalityRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const systemPrompt = typeof raw.systemPrompt === "string" ? raw.systemPrompt : "";
  const personaId =
    typeof raw.personaId === "string"
      ? raw.personaId
      : raw.personaId === null
        ? null
        : null;
  const personaLabel = formatPersonaLabel(personaId, typeof raw.personaLabel === "string" ? raw.personaLabel : undefined);
  const provider: "pollinations" | "openrouter" = raw.provider === "openrouter" ? "openrouter" : "pollinations";
  const model = typeof raw.model === "string" && raw.model.trim().length > 0 ? raw.model.trim() : undefined;
  const assignedAtRaw = Number((raw as any).assignedAt);
  const updatedAtRaw = Number((raw as any).updatedAt);
  const lastUsedAtRaw = Number((raw as any).lastUsedAt);
  const usageCountRaw = Number((raw as any).usageCount);
  const now = Date.now();

  return {
    personaId,
    personaLabel,
    systemPrompt,
    provider,
    model,
    assignedAt: Number.isFinite(assignedAtRaw) ? assignedAtRaw : now,
    updatedAt: Number.isFinite(updatedAtRaw) ? updatedAtRaw : now,
    lastUsedAt: Number.isFinite(lastUsedAtRaw) ? lastUsedAtRaw : undefined,
    usageCount: Number.isFinite(usageCountRaw) && usageCountRaw > 0 ? Math.trunc(usageCountRaw) : 0,
  };
}

function ensureLoaded(): void {
  if (loaded) {
    return;
  }
  const persisted = loadPersistedState();
  const entries = persisted.chatPersonalityAssignments;
  if (entries && typeof entries === "object") {
    Object.entries(entries).forEach(([chatId, raw]) => {
      const sanitized = sanitizeRecord(raw);
      if (sanitized) {
        store.set(chatId, sanitized);
      }
    });
  }
  loaded = true;
}

function persist(): void {
  const payload: Record<string, ChatPersonalityRecord> = {};
  for (const [chatId, record] of store.entries()) {
    payload[chatId] = { ...record };
  }
  savePersistedState({ chatPersonalityAssignments: payload });
}

export function getChatPersonality(chatId: string): ChatPersonalityRecord | undefined {
  if (!chatId) {
    return undefined;
  }
  ensureLoaded();
  const entry = store.get(chatId);
  return entry ? { ...entry } : undefined;
}

export function describeChatPersonality(chatId: string): ChatPersonalityDescriptor | undefined {
  const record = getChatPersonality(chatId);
  if (!record) {
    return undefined;
  }
  const { systemPrompt, ...descriptor } = record;
  return descriptor;
}

export function describeAllChatPersonalities(): Record<string, ChatPersonalityDescriptor> {
  ensureLoaded();
  const result: Record<string, ChatPersonalityDescriptor> = {};
  for (const [chatId, record] of store.entries()) {
    const { systemPrompt, ...descriptor } = record;
    result[chatId] = descriptor;
  }
  return result;
}

export function ensureChatPersonality(chatId: string, defaults?: Partial<ChatPersonalityRecord>): ChatPersonalityRecord {
  ensureLoaded();
  const existing = store.get(chatId);
  if (existing) {
    return { ...existing };
  }

  const cfg = appConfig() as any;
  const personaId =
    typeof defaults?.personaId === "string"
      ? defaults.personaId
      : typeof cfg.currentPersona === "string"
        ? cfg.currentPersona
        : null;
  const personaLabel = formatPersonaLabel(personaId, defaults?.personaLabel);
  const systemPrompt =
    typeof defaults?.systemPrompt === "string" && defaults.systemPrompt.trim().length > 0
      ? defaults.systemPrompt
      : typeof cfg.systemPrompt === "string"
        ? cfg.systemPrompt
        : "";
  const provider: "pollinations" | "openrouter" =
    defaults?.provider === "openrouter" || cfg.llmProvider === "openrouter"
      ? "openrouter"
      : "pollinations";
  const model =
    typeof defaults?.model === "string" && defaults.model.trim().length > 0
      ? defaults.model.trim()
      : typeof cfg.openrouterModel === "string" && cfg.openrouterModel.trim().length > 0
        ? cfg.openrouterModel.trim()
        : undefined;
  const now = Date.now();

  const record: ChatPersonalityRecord = {
    personaId,
    personaLabel,
    systemPrompt,
    provider,
    model,
    assignedAt: defaults?.assignedAt ?? now,
    updatedAt: defaults?.updatedAt ?? now,
    lastUsedAt: defaults?.lastUsedAt,
    usageCount: defaults?.usageCount ?? 0,
  };

  store.set(chatId, record);
  persist();
  return { ...record };
}

export function updateChatPersonality(chatId: string, update: Partial<ChatPersonalityRecord>): ChatPersonalityRecord {
  if (!chatId) {
    throw new Error("Chat ID is required to update personality");
  }

  ensureLoaded();
  const base = store.get(chatId) ?? ensureChatPersonality(chatId);
  const current = store.get(chatId) ?? base;
  const now = Date.now();

  const personaId =
    update.personaId === undefined
      ? current.personaId
      : update.personaId === null
        ? null
        : update.personaId;
  const personaLabel = formatPersonaLabel(personaId, update.personaLabel ?? current.personaLabel);
  const systemPrompt =
    typeof update.systemPrompt === "string" && update.systemPrompt.trim().length > 0
      ? update.systemPrompt
      : current.systemPrompt;
  const provider: "pollinations" | "openrouter" =
    update.provider === "openrouter"
      ? "openrouter"
      : update.provider === "pollinations"
        ? "pollinations"
        : current.provider;
  const model =
    update.model === undefined
      ? current.model
      : typeof update.model === "string" && update.model.trim().length > 0
        ? update.model.trim()
        : undefined;
  const usageCount =
    update.usageCount === undefined
      ? current.usageCount
      : Number.isFinite(update.usageCount)
        ? Math.max(0, Math.trunc(update.usageCount as number))
        : current.usageCount;
  const next: ChatPersonalityRecord = {
    personaId,
    personaLabel,
    systemPrompt,
    provider,
    model,
    assignedAt: current.assignedAt,
    updatedAt: now,
    lastUsedAt: update.lastUsedAt ?? current.lastUsedAt,
    usageCount,
  };

  store.set(chatId, next);
  persist();
  return { ...next };
}

export function recordChatPersonalityUsage(chatId: string): ChatPersonalityRecord {
  if (!chatId) {
    throw new Error("Chat ID is required to record usage");
  }

  ensureLoaded();
  const existing = store.get(chatId) ?? ensureChatPersonality(chatId);
  const count = Number(existing.usageCount) || 0;
  const now = Date.now();
  const next: ChatPersonalityRecord = {
    ...existing,
    usageCount: count + 1,
    lastUsedAt: now,
    updatedAt: now,
  };
  store.set(chatId, next);
  persist();
  return { ...next };
}

export function getChatSystemPrompt(chatId: string): string | undefined {
  const record = getChatPersonality(chatId);
  return record?.systemPrompt;
}
