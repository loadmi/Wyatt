import { appConfig } from "../config";
import { availableJsonFiles } from "../llm/personalities";
import { loadPersistedState, savePersistedState } from "../persistence";
import { loadPersonaFile } from "../utils/personaLoader";

export type ChatPersonaRecord = {
  personaId: string;
  systemPrompt: string;
  createdAt: number;
  updatedAt: number;
};

export type ChatPersonaSummary = {
  personaId: string;
  personaLabel: string;
  usesDefaultPersona: boolean;
  updatedAt: number;
};

// LRU cache implementation for persona prompts to prevent unbounded memory growth
class LRUPersonaCache {
  private readonly cache = new Map<string, { prompt: string; lastAccessed: number }>();
  private readonly maxSize: number;

  constructor(maxSize: number = 50) {
    this.maxSize = maxSize;
  }

  get(key: string): string | undefined {
    const entry = this.cache.get(key);
    if (entry) {
      // Update last accessed time for LRU tracking
      entry.lastAccessed = Date.now();
      return entry.prompt;
    }
    return undefined;
  }

  set(key: string, prompt: string): void {
    // Evict oldest entry if cache is full
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const oldestKey = this.findOldestKey();
      if (oldestKey) {
        this.cache.delete(oldestKey);
        console.log(`Evicted persona "${oldestKey}" from cache (LRU)`);
      }
    }

    this.cache.set(key, { prompt, lastAccessed: Date.now() });
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
  }

  private findOldestKey(): string | null {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    return oldestKey;
  }

  size(): number {
    return this.cache.size;
  }
}

const personaStore = new Map<string, ChatPersonaRecord>();
const personaPromptCache = new LRUPersonaCache(50); // Max 50 personas cached
let storeLoaded = false;

function normaliseChatId(chatId: string): string {
  if (typeof chatId !== "string") {
    return String(chatId ?? "").trim();
  }
  return chatId.trim();
}

function normalisePersonaId(personaId: string): string {
  return typeof personaId === "string" ? personaId.trim() : "";
}

function now(): number {
  return Date.now();
}

async function loadStore(): Promise<void> {
  if (storeLoaded) {
    return;
  }

  try {
    const persisted = await loadPersistedState();
    const raw = persisted.chatPersonalities;
    if (raw && typeof raw === "object") {
      for (const [chatId, entry] of Object.entries(raw)) {
        if (!chatId) continue;
        const personaId = normalisePersonaId((entry as any)?.personaId);
        const systemPrompt = typeof (entry as any)?.systemPrompt === "string" ? (entry as any).systemPrompt : "";
        if (!personaId || !systemPrompt) continue;
        const createdRaw = Number((entry as any)?.createdAt);
        const updatedRaw = Number((entry as any)?.updatedAt);
        const createdAt = Number.isFinite(createdRaw) ? createdRaw : Number.isFinite(updatedRaw) ? updatedRaw : now();
        const updatedAt = Number.isFinite(updatedRaw) ? updatedRaw : createdAt;
        const record: ChatPersonaRecord = {
          personaId,
          systemPrompt,
          createdAt,
          updatedAt,
        };
        personaStore.set(chatId, record);
        if (systemPrompt.trim().length > 0 && !personaPromptCache.has(personaId)) {
          personaPromptCache.set(personaId, systemPrompt);
        }
      }
    }
  } catch (error) {
    console.warn("Failed to load chat personalities:", (error as any)?.message || error);
  }

  storeLoaded = true;
}

function persistStore(): void {
  const payload: Record<string, { personaId: string; systemPrompt: string; createdAt: number; updatedAt: number }> = {};
  for (const [chatId, record] of personaStore.entries()) {
    payload[chatId] = {
      personaId: record.personaId,
      systemPrompt: record.systemPrompt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
  // Call async function without awaiting - fire and forget
  savePersistedState({ chatPersonalities: payload }).catch((e: any) => {
    console.warn("Failed to persist chat personalities:", e?.message || e);
  });
}

export function formatPersonaLabel(personaId: string): string {
  const trimmed = normalisePersonaId(personaId);
  if (!trimmed) return "Unknown";
  const withoutExt = trimmed.replace(/\.[^/.]+$/, "");
  const parts = withoutExt
    .replace(/[_-]+/g, " ")
    .split(" ")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return trimmed;
  }
  return parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getDefaultPersonaId(): string {
  const cfg = appConfig() as any;
  const configured = normalisePersonaId(cfg?.currentPersona);
  if (configured) {
    return configured;
  }
  if (availableJsonFiles.includes("granny.json")) {
    return "granny.json";
  }
  if (availableJsonFiles.length > 0) {
    return availableJsonFiles[0];
  }
  return "granny.json";
}

async function resolvePersonaPrompt(personaId: string): Promise<string> {
  await loadStore();
  const trimmed = normalisePersonaId(personaId);
  if (!trimmed) {
    throw new Error("Persona identifier is required.");
  }
  if (personaPromptCache.has(trimmed)) {
    return personaPromptCache.get(trimmed)!;
  }

  const cfg = appConfig() as any;
  const defaultId = getDefaultPersonaId();
  if (trimmed === defaultId) {
    const configPrompt = typeof cfg?.systemPrompt === "string" ? cfg.systemPrompt.trim() : "";
    if (configPrompt) {
      personaPromptCache.set(trimmed, configPrompt);
      return configPrompt;
    }
  }

  if (!availableJsonFiles.includes(trimmed)) {
    throw new Error(`Persona "${trimmed}" is not available.`);
  }

  // Use shared persona loader utility for consistent error handling
  const prompt = await loadPersonaFile(trimmed);
  personaPromptCache.set(trimmed, prompt);
  return prompt;
}

async function getDefaultPersonaRecord(): Promise<{ personaId: string; systemPrompt: string }> {
  const personaId = getDefaultPersonaId();
  const cfg = appConfig() as any;
  const promptFromConfig = typeof cfg?.systemPrompt === "string" ? cfg.systemPrompt.trim() : "";
  if (promptFromConfig) {
    personaPromptCache.set(personaId, promptFromConfig);
    return { personaId, systemPrompt: promptFromConfig };
  }
  const prompt = await resolvePersonaPrompt(personaId);
  return { personaId, systemPrompt: prompt };
}

function toSummary(record: ChatPersonaRecord): ChatPersonaSummary {
  const defaultId = getDefaultPersonaId();
  return {
    personaId: record.personaId,
    personaLabel: formatPersonaLabel(record.personaId),
    usesDefaultPersona: normalisePersonaId(record.personaId) === normalisePersonaId(defaultId),
    updatedAt: record.updatedAt,
  };
}

export async function ensureChatPersonaRecord(chatId: string): Promise<ChatPersonaRecord> {
  await loadStore();
  const key = normaliseChatId(chatId);
  if (!key) {
    throw new Error("Chat identifier is required to resolve persona.");
  }
  const existing = personaStore.get(key);
  if (existing) {
    return existing;
  }
  const defaults = await getDefaultPersonaRecord();
  const timestamp = now();
  const record: ChatPersonaRecord = {
    personaId: defaults.personaId,
    systemPrompt: defaults.systemPrompt,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  personaStore.set(key, record);
  persistStore();
  return record;
}

export async function getChatPersonaSummary(chatId: string): Promise<ChatPersonaSummary> {
  const record = await ensureChatPersonaRecord(chatId);
  return toSummary(record);
}

export async function updateChatPersona(chatId: string, personaId: string): Promise<{ record: ChatPersonaRecord; summary: ChatPersonaSummary }> {
  await loadStore();
  const key = normaliseChatId(chatId);
  if (!key) {
    throw new Error("Chat identifier is required to update persona.");
  }
  const trimmedPersona = normalisePersonaId(personaId);
  if (!trimmedPersona) {
    throw new Error("Persona is required.");
  }
  const systemPrompt = await resolvePersonaPrompt(trimmedPersona);
  const existing = personaStore.get(key);
  const timestamp = now();
  const record: ChatPersonaRecord = {
    personaId: trimmedPersona,
    systemPrompt,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  personaStore.set(key, record);
  // Update LRU cache with new prompt
  personaPromptCache.set(trimmedPersona, systemPrompt);
  persistStore();
  return { record, summary: toSummary(record) };
}

export async function resetChatPersonaToDefault(chatId: string): Promise<{ record: ChatPersonaRecord; summary: ChatPersonaSummary }> {
  const defaults = await getDefaultPersonaRecord();
  return updateChatPersona(chatId, defaults.personaId);
}

export function getChatPersonaSystemPromptSync(chatId: string): string | null {
  // Note: This function remains synchronous but loadStore is now async
  // We'll need to ensure loadStore is called asynchronously elsewhere before this is used
  // For now, we'll keep the synchronous call but it won't wait for the promise
  loadStore().catch(e => {
    console.warn("Failed to load store in sync function:", (e as any)?.message || e);
  });
  const key = normaliseChatId(chatId);
  if (!key) return null;
  const existing = personaStore.get(key);
  return existing?.systemPrompt ?? null;
}
