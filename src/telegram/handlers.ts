// src/telegram/handlers.ts
import { NewMessage, NewMessageEvent } from "telegram/events";
import { Api } from "telegram";
import { Button } from "telegram/tl/custom/button";
import bigInt from "big-integer";
import { appConfig, randomInRange, sleep } from "../config";
import { getResponse, getSuggestedReplies } from "../llm/llm";
import { recordInbound, recordOutbound } from "../metrics";
import { ensureChatPersonaRecord, formatPersonaLabel, getDefaultPersonaId } from "./chatPersonality";
import { toIdString, toStableChatKey } from "./idUtils";
import { sanitizeMessageText } from "../utils/logSanitizer";


// Simple in-memory cache of fetched histories per user to avoid re-fetching
// the entire history on every message. Updated lazily when accessed.
type ContextEntry = {
  id: number;
  date: number;
  from: "user" | "me";
  text: string;
};

// LRU cache implementation with size limits
class LRUHistoryCache {
  private cache = new Map<string, { data: ContextEntry[]; lastAccessed: number }>();
  
  get(key: string): ContextEntry[] | undefined {
    const entry = this.cache.get(key);
    if (entry) {
      entry.lastAccessed = Date.now();
      return entry.data;
    }
    return undefined;
  }
  
  set(key: string, data: ContextEntry[]): void {
    const config = appConfig();
    const maxMessages = config.historyCache?.maxMessagesPerChat || 500;
    const maxChats = config.historyCache?.maxCachedChats || 100;
    
    // Trim messages if exceeding limit
    const trimmedData = data.length > maxMessages
      ? data.slice(-maxMessages)
      : data;
    
    // Evict oldest chat if cache is full
    if (this.cache.size >= maxChats && !this.cache.has(key)) {
      const oldestKey = this.findOldestKey();
      if (oldestKey) {
        this.cache.delete(oldestKey);
        console.log(`Evicted chat ${oldestKey} from history cache (LRU)`);
      }
    }
    
    this.cache.set(key, { data: trimmedData, lastAccessed: Date.now() });
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
  
  clear(): void {
    this.cache.clear();
  }
  
  size(): number {
    return this.cache.size;
  }
}

const historyCache = new LRUHistoryCache();

const FALLBACK_SUGGESTIONS = [
  { text: "Oh goodness, that's quite something—should I keep them chatting?", emotion: "curious" },
  { text: "Let me play along a bit—how about I ask for more details?", emotion: "playful" },
  { text: "I can stall them a little longer. Want me to stay curious?", emotion: "friendly" },
  { text: "This seems suspicious. Should I be more cautious?", emotion: "skeptical" },
  { text: "I'm a bit concerned about this. How should I respond?", emotion: "concerned" }
];

type HumanOverrideDecision =
  | { type: "selection"; text: string; fromSuggestion: boolean; index?: number }
  | { type: "ignore"; reason: "timeout" | "dismissed" };

type PendingHumanOverride = {
  id: string;
  conversationKey: string;
  humanPeerKey: string;
  humanPeer: any;
  requestMessageId?: number;
  suggestions: Array<{text: string, emotion: string}>;
  createdAt: number;
  expiresAt: number;
  resolved: boolean;
  resolve: (decision: HumanOverrideDecision) => void;
  original: {
    inputPeer: any;
    message: any;
    senderIdString: string;
    chatId?: string;
    personaRecord: any;
    startedAt: number;
  };
};

const pendingHumanOverrides = new Map<string, PendingHumanOverride>();
let cachedHumanPeerKey: string | null = null;
let cachedHumanPeerRaw: string | null = null;

// Periodic cleanup of expired overrides to prevent memory leaks
function cleanupExpiredOverrides(): void {
  const now = Date.now();
  const expired: string[] = [];
  
  for (const [id, override] of pendingHumanOverrides.entries()) {
    if (override.resolved || override.expiresAt <= now) {
      expired.push(id);
    }
  }
  
  for (const id of expired) {
    pendingHumanOverrides.delete(id);
  }
  
  if (expired.length > 0) {
    console.log(`Cleaned up ${expired.length} expired supervisor override(s)`);
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupExpiredOverrides, 5 * 60 * 1000);

// Cached self info to detect mentions/replies in group chats
let selfUsernameCached: string | null = null;
let selfIdStringCached: string | null = null;

// Wake up routine: track last interaction time per user/chat
type InteractionRecord = {
   lastInteraction: number; // timestamp
   chatId: string; // to distinguish between different chats
 };

// Load persisted interaction tracker data
async function loadInteractionTracker(): Promise<Map<string, InteractionRecord>> {
   try {
     const { loadPersistedState } = require("../persistence");
     const persisted = await loadPersistedState();
     const tracker = new Map<string, InteractionRecord>();

     if (persisted.interactionTracker) {
       Object.entries(persisted.interactionTracker).forEach(([key, record]) => {
         tracker.set(key, record as InteractionRecord);
       });
     }

     return tracker;
   } catch (e) {
     console.warn("Failed to load interaction tracker:", (e as any)?.message || e);
     return new Map<string, InteractionRecord>();
   }
 }

// Initialize interaction tracker asynchronously
const interactionTracker = new Map<string, InteractionRecord>();
loadInteractionTracker().then(tracker => {
  tracker.forEach((value, key) => {
    interactionTracker.set(key, value);
  });
}).catch(e => {
  console.warn("Failed to initialize interaction tracker:", (e as any)?.message || e);
});

// Helper function to get cache key for interaction tracking
function getInteractionKey(senderId: string, chatId?: string): string {
  // For private chats, use sender ID. For groups, combine sender and chat ID
  return chatId ? `${senderId}_${chatId}` : senderId;
}

// Helper function to check if bot should wake up (has been inactive)
function shouldWakeUp(senderId: string, chatId: string | undefined): boolean {
   const key = getInteractionKey(senderId, chatId);
  const record = interactionTracker.get(key);

  if (!record) {
    // No previous interaction, bot is "fresh" - no wake up needed
    return false;
  }

  const timeSinceLastInteraction = Date.now() - record.lastInteraction;
  return timeSinceLastInteraction > appConfig().supervisor.sleepThresholdMs;
}

// Helper function to save interaction tracker to persistence
function saveInteractionTracker(): void {
   try {
     const { savePersistedState } = require("../persistence");
     const data: Record<string, InteractionRecord> = {};
     interactionTracker.forEach((record, key) => {
       data[key] = record;
     });
     // Call async function without awaiting - fire and forget
     savePersistedState({ interactionTracker: data }).catch((e: any) => {
       console.warn("Failed to save interaction tracker:", e?.message || e);
     });
   } catch (e) {
     console.warn("Failed to save interaction tracker:", (e as any)?.message || e);
   }
 }

// Helper function to update last interaction time
function updateLastInteraction(senderId: string, chatId: string | undefined): void {
   const key = getInteractionKey(senderId, chatId);
   interactionTracker.set(key, {
     lastInteraction: Date.now(),
     chatId: chatId || senderId
   });
   // Persist the updated interaction data
   saveInteractionTracker();
 }

// Helper function to get wake up delay duration
function getWakeUpDelay(): number {
  const config = appConfig();
  return randomInRange(config.supervisor.wakeUpDelayMs.min, config.supervisor.wakeUpDelayMs.max);
}

function getConfiguredHumanTarget(): string | null {
  const cfg = appConfig() as any;
  // Prefer new supervisor.contact field, fallback to legacy humanEscalationChatId
  const raw = cfg?.supervisor?.contact || cfg?.humanEscalationChatId;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Check if supervisor should be contacted based on mode and wake-up status
function shouldContactSupervisor(senderId: string, chatId?: string): boolean {
  const cfg = appConfig() as any;
  const mode = cfg?.supervisor?.mode || 'wake-up';
  
  // If disabled, never contact supervisor
  if (mode === 'disabled') {
    return false;
  }
  
  // If always mode, always contact supervisor
  if (mode === 'always') {
    return true;
  }
  
  // If wake-up mode, check if bot needs to wake up
  if (mode === 'wake-up') {
    return shouldWakeUp(senderId, chatId);
  }
  
  return false;
}

// Get appropriate fallback delay based on supervisor mode
function getSupervisorFallbackDelay(): number {
  const cfg = appConfig() as any;
  const mode = cfg?.supervisor?.mode || 'wake-up';
  
  if (mode === 'always') {
    const delays = cfg?.supervisor?.alwaysFallbackDelayMs || {
      min: 30_000,
      max: 60_000
    };
    return randomInRange(delays.min, delays.max);
  }
  
  // Default to wake-up delays for 'wake-up' mode or fallback
  const delays = cfg?.supervisor?.wakeUpDelayMs || {
    min: 5_000,
    max: 10_000
  };
  return randomInRange(delays.min, delays.max);
}

async function resolveHumanPeer(client: any): Promise<{ input: any; key: string } | null> {
  const target = getConfiguredHumanTarget();
  if (!target) return null;

  const queries: any[] = [target];
  if (/^\d+$/.test(target)) {
    const numeric = Number(target);
    if (Number.isFinite(numeric)) queries.push(numeric);
    try { queries.push(BigInt(target)); } catch { }
  } else if (target.startsWith("@")) {
    queries.push(target.slice(1));
  }

  let lastError: unknown = null;
  for (const query of queries) {
    try {
      const entity = await client.getInputEntity(query);
      const key = toIdString(entity) || toIdString((entity as any)?.peer) || toIdString(query) || target;
      cachedHumanPeerKey = key;
      cachedHumanPeerRaw = target;
      return { input: entity, key: key || target };
    } catch (error) {
      lastError = error;
    }
  }

  cachedHumanPeerKey = null;
  cachedHumanPeerRaw = null;
  console.warn("Failed to resolve human escalation contact:", (lastError as any)?.message || lastError);
  return null;
}

function findPendingOverrideForMessage(message: any): PendingHumanOverride | undefined {
  const replyId =
    (message as any)?.replyToMsgId ||
    (message as any)?.replyTo?.replyToMsgId;

  const all = Array.from(pendingHumanOverrides.values()).filter((entry) => !entry.resolved);
  if (replyId) {
    const byReply = all.find((entry) => entry.requestMessageId === replyId);
    if (byReply) return byReply;
  }

  const peerKey = toIdString(message?.peerId);
  const senderKey = toIdString((message?.fromId as any)?.userId);
  if (peerKey || senderKey) {
    const matches = all.filter(
      (entry) => entry.humanPeerKey === peerKey || entry.humanPeerKey === senderKey,
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      return matches.sort((a, b) => b.createdAt - a.createdAt)[0];
    }
  }

  if (all.length === 0) return undefined;
  return all.sort((a, b) => b.createdAt - a.createdAt)[0];
}

type ParsedHumanResponse =
  | { kind: "suggestion"; index: number; text: string }
  | { kind: "custom"; text: string }
  | { kind: "ignore" };

function parseHumanResponse(raw: string, suggestions: Array<{text: string, emotion: string}>): ParsedHumanResponse | null {
  const text = (raw || "").trim();
  if (!text) return null;

  const lowered = text.toLowerCase();
  const ignoreTokens = ["ignore", "skip", "dismiss", "auto", "none", "default"];
  if (ignoreTokens.includes(lowered)) {
    return { kind: "ignore" };
  }

  const numberPatterns = [
    /^#?(\d{1,2})$/, // 1, #1
    /^#?(\d{1,2})[.)]?$/, // 1. or 1)
    /^(?:send|option|use|reply|choice|pick|button)\s*#?(\d{1,2})$/, // send 1
    /^send\s+option\s+(\d{1,2})$/,
  ];

  for (const pattern of numberPatterns) {
    const match = lowered.match(pattern);
    if (match) {
      const idx = Number(match[1]);
      if (Number.isFinite(idx) && idx >= 1 && idx <= suggestions.length) {
        const suggestion = suggestions[idx - 1];
        const text = typeof suggestion === 'string' ? suggestion : suggestion.text;
        if (text && text.trim()) {
          return { kind: "suggestion", index: idx - 1, text: text.trim() };
        }
      }
    }
  }

  return { kind: "custom", text };
}

async function getSelfIdentity(client: any): Promise<{ usernameLower: string | null; idString: string | null }> {
  if (selfUsernameCached !== null || selfIdStringCached !== null) {
    return { usernameLower: selfUsernameCached, idString: selfIdStringCached };
  }
  try {
    const me = await client.getMe();
    const username = (me as any)?.username;
    selfUsernameCached = username ? String(username).toLowerCase() : null;
    try {
      const rawId = (me as any)?.id ?? (me as any)?._id;
      // Convert id to a stable string when possible
      if (rawId !== undefined && rawId !== null) {
        if (typeof rawId === "bigint") selfIdStringCached = String(rawId);
        else if (typeof rawId === "number" || typeof rawId === "string") selfIdStringCached = String(rawId);
        else if (typeof rawId?.toString === "function") selfIdStringCached = String(rawId.toString());
      }
    } catch { selfIdStringCached = null; }
  } catch {
    selfUsernameCached = null;
    selfIdStringCached = null;
  }
  return { usernameLower: selfUsernameCached, idString: selfIdStringCached };
}

function isPeerUser(peerId: any): boolean {
  try {
    return peerId instanceof Api.PeerUser || peerId?.className === "PeerUser";
  } catch {
    return false;
  }
}

function isPeerChatOrChannel(peerId: any): boolean {
  try {
    return (
      peerId instanceof Api.PeerChat ||
      peerId instanceof Api.PeerChannel ||
      peerId?.className === "PeerChat" ||
      peerId?.className === "PeerChannel"
    );
  } catch {
    return false;
  }
}

// ID conversion utilities moved to ./idUtils.ts for consistency
// Use toIdString() and toStableChatKey() from that module

async function shouldRespondInContext(message: any, client: any): Promise<boolean> {
  const peerId = message?.peerId;

  // Direct/private chats: always respond
  if (isPeerUser(peerId)) return true;

  // Group/supergroup/channel: respond only if mentioned or replied to our message
  if (!isPeerChatOrChannel(peerId)) return false;

  const text: string = (message?.message ?? "").toString();

  // Mention check (by @username or by entity pointing to self)
  const self = await getSelfIdentity(client);
  const usernameMention = !!(self.usernameLower && text.toLowerCase().includes("@" + self.usernameLower));
  if (usernameMention) return true;

  // Entity-based mention (@display name without username)
  try {
    const entities = (message as any)?.entities;
    if (Array.isArray(entities) && entities.length > 0 && self.idString) {
      for (const ent of entities) {
        // Mentions without @username carry a userId in the entity
        if (
          ent instanceof Api.MessageEntityMentionName ||
          ent?.className === "MessageEntityMentionName"
        ) {
          const entUserIdStr = toIdString((ent as any).userId);
          if (entUserIdStr && self.idString && entUserIdStr === self.idString) {
            return true;
          }
        }
        // Also accept explicit @mention entities as a backup
        if (ent instanceof Api.MessageEntityMention || ent?.className === "MessageEntityMention") {
          try {
            const offset = (ent as any).offset ?? 0;
            const length = (ent as any).length ?? 0;
            const segment = text.substr(offset, length).toLowerCase();
            if (self.usernameLower && segment === "@" + self.usernameLower) return true;
          } catch { }
        }
      }
    }
  } catch { }

  // Reply check: if user replied to one of our (outgoing) messages
  try {
    // Some libraries set message.mentioned when you're mentioned; accept it if present
    if ((message as any)?.mentioned === true) return true;

    const hasReply = !!(message?.replyToMsgId || message?.replyTo?.replyToMsgId || message?.isReply);
    if (hasReply && typeof message.getReplyMessage === "function") {
      const replied = await message.getReplyMessage();
      if (replied && replied.out === true) return true;
    }
  } catch { }

  return false;
}

export type LLMContextEntry = {
  role: "assistant" | "system" | "user";
  content: string;
};

// Converts local context entries to LLM-compatible messages (oldest -> newest).
// Optionally prepend a system prompt if provided.
// Optimized to reduce allocations: pre-allocates array with known size instead of using map() + spread.
export function convertContextToLLM(context: ContextEntry[], systemPrompt?: string): LLMContextEntry[] {
  // Optimization: Pre-allocate array with exact size to avoid dynamic resizing
  const hasSystemPrompt = systemPrompt && systemPrompt.trim().length > 0;
  const totalSize = hasSystemPrompt ? context.length + 1 : context.length;
  const result: LLMContextEntry[] = new Array(totalSize);
  
  let writeIndex = 0;
  
  // Add system prompt first if provided (reuse trimmed value to avoid redundant trim())
  if (hasSystemPrompt) {
    result[writeIndex++] = { role: "system", content: systemPrompt!.trim() };
  }
  
  // Convert context entries directly into pre-allocated array
  for (let i = 0; i < context.length; i++) {
    const m = context[i];
    result[writeIndex++] = {
      role: m.from === "me" ? "assistant" : "user",
      content: m.text,
    };
  }
  
  return result;
}

async function handleHumanOverrideMessage(message: any, client: any): Promise<boolean> {
  const configured = getConfiguredHumanTarget();
  if (!configured) return false;

  const override = findPendingOverrideForMessage(message);
  const peerKey = toIdString(message?.peerId);
  const senderKey = toIdString((message?.fromId as any)?.userId);
  const candidates = [peerKey, senderKey];

  if (override && !candidates.includes(override.humanPeerKey)) {
    candidates.push(override.humanPeerKey);
  }
  if (cachedHumanPeerKey && !candidates.includes(cachedHumanPeerKey)) {
    candidates.push(cachedHumanPeerKey);
  }

  const trimmed = configured.trim();
  const normalized = trimmed.toLowerCase();
  let isConfiguredContact = false;

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate === trimmed || candidate === normalized) {
      isConfiguredContact = true;
      cachedHumanPeerKey = candidate;
      cachedHumanPeerRaw = trimmed;
      break;
    }
  }

  if (!isConfiguredContact && trimmed.startsWith("@")) {
    try {
      const sender = await message.getSender?.();
      const usernameRaw: string | undefined =
        sender?.username ||
        (Array.isArray((sender as any)?.usernames) ? (sender as any).usernames[0]?.username : undefined);
      if (usernameRaw) {
        const username = usernameRaw.toLowerCase();
        const expected = normalized.replace(/^@/, "");
        if (username === expected) {
          isConfiguredContact = true;
          cachedHumanPeerRaw = trimmed;
        }
      }
    } catch { }
  }

  if (!override && !isConfiguredContact) {
    return false;
  }

  if (!override) {
    console.log("Received message from wake-up supervisor with no pending request. Ignoring.");
    return true;
  }

  if (override.resolved) {
    return true;
  }

  if (override.expiresAt <= Date.now()) {
    override.resolved = true;
    override.resolve({ type: "ignore", reason: "timeout" });
    try {
      await client.sendMessage(override.humanPeer, {
        message: "⏰ That wake-up request already expired. The bot has resumed automatically.",
      });
    } catch { }
    return true;
  }

  const parsed = parseHumanResponse((message?.message ?? "").toString(), override.suggestions);
  if (!parsed) {
    try {
      await client.sendMessage(override.humanPeer, {
        message: `Please choose 1-5 or type a custom reply to forward.`,
      });
    } catch { }
    return true;
  }

  override.resolved = true;
  if (parsed.kind === "ignore") {
    override.resolve({ type: "ignore", reason: "dismissed" });
  } else if (parsed.kind === "suggestion") {
    override.resolve({ type: "selection", text: parsed.text, fromSuggestion: true, index: parsed.index + 1 });
  } else {
    override.resolve({ type: "selection", text: parsed.text, fromSuggestion: false });
  }

  return true;
}

async function applyReadingDelay(client: any, message: any, inputPeer: any): Promise<void> {
  const waitBefore = randomInRange(
    appConfig().messageDelays.waitBeforeTypingMs.min,
    appConfig().messageDelays.waitBeforeTypingMs.max
  );
  
  // Mark the incoming message as read right before starting the wait timer
  try {
    const peer = inputPeer || message.peerId;
    const maxId = (message as any)?.id || 0;
    if (peer && maxId) {
      await (client as any)
        .invoke(
          new Api.messages.ReadHistory({
            peer,
            maxId,
          })
        )
        .catch(() => { });
    }
  } catch (e) {
    console.warn("Failed to mark message as read:", (e as any)?.message || e);
  }
  
  await sleep(waitBefore);
}

async function applyTypingDelay(client: any, message: any, inputPeer: any): Promise<void> {
  const typingFor = randomInRange(
    appConfig().messageDelays.typingDurationMs.min,
    appConfig().messageDelays.typingDurationMs.max
  );
  
  const peer = inputPeer || message.peerId;
  const sendTyping = () =>
    (client as any)
      .invoke(
        new Api.messages.SetTyping({
          peer,
          action: new Api.SendMessageTypingAction(),
        })
      )
      .catch(() => { });

  // Fire immediately, then keep alive per config
  sendTyping();
  const interval = setInterval(sendTyping, appConfig().messageDelays.typingKeepaliveMs);

  await sleep(typingFor);
  
  // Stop typing
  clearInterval(interval);
  (client as any)
    .invoke(
      new Api.messages.SetTyping({
        peer,
        action: new Api.SendMessageCancelAction(),
      })
    )
    .catch(() => { });
}

/**
 * Sends a message with automatic fallback to API method if the high-level method fails.
 * Handles group context detection and reply-to logic automatically.
 * @returns true if message was sent successfully, false otherwise
 */
async function sendMessageWithFallback(params: {
  client: any;
  message: any;
  inputPeer: any;
  replyText: string;
  senderIdString: string;
  chatId?: string;
  startedAt: number;
  personaRecord: any;
  logPrefix?: string;
}): Promise<boolean> {
  const { client, message, inputPeer, replyText, senderIdString, chatId, startedAt, personaRecord, logPrefix = "" } = params;
  const trimmed = (replyText || "").trim();
  if (!trimmed) {
    console.warn("Empty reply text; skipping send.");
    return false;
  }

  const isGroupContext = isPeerChatOrChannel(message?.peerId);
  let outboundRecorded = false;

  // Try high-level sendMessage first
  try {
    const sendOptions: any = { message: trimmed };
    if (isGroupContext) {
      sendOptions.replyTo = (message as any).id;
    }
    await client.sendMessage(inputPeer || message.peerId, sendOptions);
    recordOutbound(senderIdString, Date.now() - startedAt);
    outboundRecorded = true;
    console.log(
      `✅ ${logPrefix}Reply sent to ${senderIdString} using ${formatPersonaLabel(
        personaRecord?.personaId || getDefaultPersonaId(),
      )}: "${trimmed}"`,
    );
    updateLastInteraction(senderIdString, chatId);
    return true;
  } catch (error) {
    console.error(`${logPrefix}Failed to send message:`, error);
  }

  // Fallback to low-level API
  try {
    const sendParams: any = {
      peer: inputPeer || message.peerId,
      message: trimmed,
      randomId: bigInt(Math.floor(Math.random() * 1e16)),
    };
    if (isGroupContext) {
      sendParams.replyTo = new Api.InputReplyToMessage({ replyToMsgId: (message as any).id });
    }
    await client.invoke(new Api.messages.SendMessage(sendParams));
    if (!outboundRecorded) {
      recordOutbound(senderIdString, Date.now() - startedAt);
    }
    console.log(
      `✅ ${logPrefix}Reply sent via API to ${senderIdString} using ${formatPersonaLabel(
        personaRecord?.personaId || getDefaultPersonaId(),
      )}: "${trimmed}"`,
    );
    updateLastInteraction(senderIdString, chatId);
    return true;
  } catch (apiError) {
    console.error(`${logPrefix}API fallback also failed:`, apiError);
  }

  return false;
}

async function sendImmediateReply(params: {
  client: any;
  message: any;
  inputPeer: any;
  replyText: string;
  senderIdString: string;
  chatId?: string;
  startedAt: number;
  personaRecord: any;
}): Promise<boolean> {
  const { client, message, inputPeer, replyText, senderIdString, chatId, startedAt, personaRecord } = params;
  
  // Apply reading delay (marks as read and waits)
  await applyReadingDelay(client, message, inputPeer);
  
  // Apply typing delay (shows typing indicator and waits)
  await applyTypingDelay(client, message, inputPeer);

  return sendMessageWithFallback({
    client,
    message,
    inputPeer,
    replyText,
    senderIdString,
    chatId,
    startedAt,
    personaRecord,
    logPrefix: "Wake-up override ",
  });
}

function formatRecentHistory(context: LLMContextEntry[], maxExchanges: number = 3): string {
  // Filter out system messages and get actual conversation
  const messages = context.filter(m => m.role !== "system");
  
  if (messages.length === 0) {
    return "";
  }
  
  // Exclude the last message (current incoming message) to avoid duplication
  // Show the messages BEFORE the current one for context
  const messagesBeforeCurrent = messages.slice(0, -1);
  
  if (messagesBeforeCurrent.length === 0) {
    return "";
  }
  
  // Get last N exchanges (each exchange is 2 messages: user + assistant)
  const totalToShow = Math.min(maxExchanges * 2, messagesBeforeCurrent.length);
  const recent = messagesBeforeCurrent.slice(-totalToShow);
  
  // Format each message compactly
  const formatted = recent.map(msg => {
    const icon = msg.role === "user" ? "👤" : "🤖";
    const text = msg.content.length > 80
      ? `${msg.content.slice(0, 77)}...`
      : msg.content;
    return `${icon} ${text}`;
  }).join("\n");
  
  return formatted;
}

async function getSenderDisplayName(message: any): Promise<string> {
  try {
    const sender = await message.getSender?.();
    if (!sender) return "";
    
    const parts: string[] = [];
    if (typeof sender.firstName === "string" && sender.firstName.trim()) {
      parts.push(sender.firstName.trim());
    }
    if (typeof sender.lastName === "string" && sender.lastName.trim()) {
      parts.push(sender.lastName.trim());
    }
    
    const fullName = parts.join(" ");
    if (fullName) return fullName;
    
    if (typeof sender.username === "string" && sender.username.trim()) {
      return `@${sender.username.trim()}`;
    }
    
    if (typeof sender.title === "string" && sender.title.trim()) {
      return sender.title.trim();
    }
  } catch (error) {
    // Silently fail if we can't get sender info
  }
  return "";
}

async function attemptHumanOverride(params: {
  client: any;
  message: any;
  inputPeer: any;
  senderIdString: string;
  chatId?: string;
  conversationKey: string;
  personaRecord: any;
  llmContext: LLMContextEntry[];
  messageText: string;
  isAlwaysMode?: boolean;
  startedAt: number;
}): Promise<boolean> {
  const {
    client,
    message,
    inputPeer,
    senderIdString,
    chatId,
    conversationKey,
    personaRecord,
    llmContext,
    messageText,
    isAlwaysMode,
    startedAt,
  } = params;

  // Get appropriate delay based on mode
  const fallbackDelay = getSupervisorFallbackDelay();
  const modeLabel = isAlwaysMode ? 'always' : 'wake-up';
  
  console.log(`🤖 Supervisor contact requested (${modeLabel} mode, ${Math.max(1, Math.round(fallbackDelay / 1000))}s timeout)...`);
  
  // Get sender's display name
  const senderName = await getSenderDisplayName(message);

  const target = getConfiguredHumanTarget();
  if (!target) {
    await sleep(fallbackDelay);
    console.log(`✅ No supervisor configured, proceeding with automated response (${modeLabel} mode)`);
    return false;
  }

  const humanPeer = await resolveHumanPeer(client);
  if (!humanPeer) {
    await sleep(fallbackDelay);
    console.log(`✅ Unable to resolve supervisor, proceeding with automated response (${modeLabel} mode)`);
    return false;
  }

  let suggestions: Array<{text: string, emotion: string}> = [];
  try {
    suggestions = await getSuggestedReplies(llmContext, 5);
  } catch (error) {
    console.warn("Failed to generate wake-up suggestions:", (error as any)?.message || error);
  }
  suggestions = suggestions
    .filter((entry): entry is {text: string, emotion: string} => {
      if (typeof entry === 'string') return false;
      return !!(entry?.text && entry.text.trim().length > 0);
    })
    .map((entry) => ({
      text: entry.text.trim(),
      emotion: entry.emotion || 'friendly'
    }));
  if (suggestions.length === 0) {
    suggestions = [...FALLBACK_SUGGESTIONS];
  }

  const truncatedMessage = (() => {
    const text = (messageText || "").trim();
    if (text.length > 600) {
      return `${text.slice(0, 600)}…`;
    }
    return text || "(no text)";
  })();

  const prettyDelay = Math.max(1, Math.round(fallbackDelay / 1000));
  const overrideId = `supervisor_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  
  // Extract persona information
  const personaLabel = formatPersonaLabel(personaRecord?.personaId || getDefaultPersonaId());
  
  // Format recent conversation history
  const recentHistory = formatRecentHistory(llmContext, 3);
  
  // Create a clear, tappable message format with emoji buttons
  const suggestionLines = suggestions.map((entry, idx) => {
    const emoji = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'][idx];
    const text = typeof entry === 'string' ? entry : entry.text;
    const emotion = typeof entry === 'string' ? '' : ` (${entry.emotion})`;
    return `${emoji} **Option ${idx + 1}**${emotion}\n   ${text}`;
  }).join("\n\n");
  
  // Format contact info with name if available
  const contactInfo = senderName
    ? `${senderName} (\`${senderIdString}\`)`
    : `\`${senderIdString}\``;
  
  // Build notification with context sections
  const notificationParts = [
    `🔔 **SUPERVISOR REQUEST** (${modeLabel.toUpperCase()} MODE)`,
    ``,
    `🎭 Active Persona: **${personaLabel}**`,
    `👤 Contact: ${contactInfo}${chatId ? ` · Chat ${chatId}` : ""}`,
  ];
  
  // Add recent conversation history if available
  if (recentHistory) {
    notificationParts.push(
      ``,
      `📝 **Recent Context:**`,
      recentHistory
    );
  }
  
  // Add current message and options
  notificationParts.push(
    ``,
    `💬 **Current Message:**`,
    truncatedMessage,
    ``,
    `━━━━━━━━━━━━━━━━`,
    `📝 **Quick Reply Options:**`,
    ``,
    suggestionLines,
    ``,
    `━━━━━━━━━━━━━━━━`,
    `⏰ Reply within **${prettyDelay}s**`,
    ``,
    `**To respond:**`,
    `• Type **1**, **2**, **3**, **4**, or **5** to select an option`,
    `• Type **ignore** to skip`,
    `• Or send your own custom message`
  );
  
  const notification = notificationParts.join("\n");

  let sent: any;
  try {
    sent = await client.sendMessage(humanPeer.input, { message: notification });
  } catch (error) {
    console.warn(`Failed to notify supervisor (${modeLabel} mode):`, (error as any)?.message || error);
    await sleep(fallbackDelay);
    console.log(`✅ Proceeding with automated response (${modeLabel} mode)`);
    return false;
  }

  const requestMessageId = typeof sent?.id === "number"
    ? sent.id
    : typeof (sent as any)?.message?.id === "number"
      ? (sent as any).message.id
      : undefined;

  const decisionPromise = new Promise<HumanOverrideDecision>((resolve) => {
    pendingHumanOverrides.set(overrideId, {
      id: overrideId,
      conversationKey,
      humanPeerKey: humanPeer.key,
      humanPeer: humanPeer.input,
      requestMessageId,
      suggestions,
      createdAt: Date.now(),
      expiresAt: Date.now() + fallbackDelay,
      resolved: false,
      resolve,
      original: {
        inputPeer,
        message,
        senderIdString,
        chatId,
        personaRecord,
        startedAt,
      },
    });
  });

  const timerPromise = sleep(fallbackDelay).then<HumanOverrideDecision>(() => ({
    type: "ignore",
    reason: "timeout",
  }));

  const decision = await Promise.race([decisionPromise, timerPromise]);
  const stored = pendingHumanOverrides.get(overrideId);
  if (stored) {
    stored.resolved = true;
    pendingHumanOverrides.delete(overrideId);
  }

  if (decision.type === "selection") {
    // Send confirmation to supervisor IMMEDIATELY, before any delays
    try {
      const ack = decision.fromSuggestion && typeof decision.index === "number"
        ? `✅ Sending suggestion ${decision.index}...`
        : "✅ Sending your reply...";
      await client.sendMessage(humanPeer.input, { message: ack });
    } catch { }

    // Now send the delayed reply to the user
    const sentOk = await sendImmediateReply({
      client,
      message,
      inputPeer,
      replyText: decision.text,
      senderIdString,
      chatId,
      startedAt,
      personaRecord,
    });
    if (sentOk) {
      return true;
    }

    try {
      await client.sendMessage(humanPeer.input, {
        message: "⚠️ I couldn't deliver that reply automatically. The bot will resume with its own response.",
      });
    } catch { }
    return false;
  }

  if (decision.reason === "dismissed") {
    try {
      await client.sendMessage(humanPeer.input, {
        message: "👍 Got it. Continuing with the automated response.",
      });
    } catch { }
    console.log(`👋 Supervisor override skipped (${modeLabel} mode); continuing automated reply.`);
    return false;
  }

  try {
    await client.sendMessage(humanPeer.input, {
      message: "⏰ No selection received. Resuming the automated reply.",
    });
  } catch { }
  console.log(`⌛ Supervisor override timed out (${modeLabel} mode); falling back to automated response.`);
  return false;
}

async function resolveInputPeerSafe(client: any, message: any): Promise<any | undefined> {
  try {
    const byMessage = await message.getInputChat?.();
    if (byMessage) return byMessage;
  } catch { }
  try {
    // Fallback: resolve via peerId or sender id
    if (message?.peerId) return await client.getInputEntity(message.peerId);
  } catch { }
  try {
    const uid = (message?.fromId as any)?.userId;
    if (uid) return await client.getInputEntity(uid);
  } catch { }
  return undefined;
}

// Fetches the full text message history with a peer (oldest -> newest order).
// Respects configured limits to prevent memory issues with very long chats.
// Optimized with larger page size (200 vs 100) for fewer API calls and performance logging.
async function fetchFullHistory(client: any, peer: any, cacheKey: string): Promise<ContextEntry[]> {
  const fetchStartTime = Date.now();
  const cached = historyCache.get(cacheKey);
  // Optimization: Increased page size from 100 to 200 to reduce API calls by ~50%
  const pageSize = 200;
  const config = appConfig();
  const maxMessages = config.historyCache?.maxMessagesPerChat || 500;

  // Fresh fetch if nothing cached yet
  if (!cached || cached.length === 0) {
    const all: ContextEntry[] = [];
    let offsetId = 0;
    let totalFetched = 0;
    let apiCalls = 0;
    
    while (totalFetched < maxMessages) {
      apiCalls++;
      const res: any = await client
        .invoke(
          new Api.messages.GetHistory({
            peer,
            offsetId,
            addOffset: 0,
            limit: pageSize,
            maxId: 0,
            minId: 0,
            hash: bigInt.zero,
          })
        )
        .catch((e: any) => {
          console.error("GetHistory failed:", e);
          return undefined;
        });

      if (!res || !Array.isArray(res.messages) || res.messages.length === 0) {
        break;
      }

      for (const m of res.messages) {
        if (m instanceof Api.Message && typeof m.message === "string" && m.message.length > 0) {
          all.push({ id: m.id, date: Number(m.date) || 0, from: m.out ? "me" : "user", text: m.message });
          totalFetched++;
          // Early termination: stop immediately if we hit the message limit mid-page
          if (totalFetched >= maxMessages) break;
        }
      }

      const last = res.messages[res.messages.length - 1];
      if (!last || typeof last.id !== "number") break;
      offsetId = last.id;
      // Early termination: exit if we've hit the limit or received fewer messages than requested
      if (res.messages.length < pageSize || totalFetched >= maxMessages) break;
    }

    all.sort((a, b) => a.id - b.id);
    historyCache.set(cacheKey, all);
    
    const fetchDuration = Date.now() - fetchStartTime;
    console.log(
      `History fetch completed for ${cacheKey}: ${totalFetched} messages in ${apiCalls} API calls (${fetchDuration}ms)`
    );
    
    if (totalFetched >= maxMessages) {
      console.log(`History fetch limited to ${maxMessages} messages for ${cacheKey}`);
    }
    
    return all;
  }

  // Incremental update: fetch only messages newer than the last cached id
  const lastKnownId = cached[cached.length - 1]?.id || 0;
  let more: ContextEntry[] = [];
  let offsetId = 0;
  let totalFetched = 0;
  let apiCalls = 0;
  const remainingCapacity = maxMessages - cached.length;
  
  while (totalFetched < remainingCapacity) {
    apiCalls++;
    const res: any = await client
      .invoke(
        new Api.messages.GetHistory({
          peer,
          offsetId,
          addOffset: 0,
          limit: pageSize,
          maxId: 0,
          minId: lastKnownId, // only messages with id > lastKnownId
          hash: bigInt.zero,
        })
      )
      .catch((e: any) => {
        console.error("GetHistory (incremental) failed:", e);
        return undefined;
      });

    if (!res || !Array.isArray(res.messages) || res.messages.length === 0) {
      break;
    }

    for (const m of res.messages) {
      if (m instanceof Api.Message && typeof m.message === "string" && m.message.length > 0) {
        // Only add items actually newer than lastKnownId
        if (typeof m.id === "number" && m.id > lastKnownId) {
          more.push({ id: m.id, date: Number(m.date) || 0, from: m.out ? "me" : "user", text: m.message });
          totalFetched++;
          // Early termination: stop immediately if we hit the capacity limit mid-page
          if (totalFetched >= remainingCapacity) break;
        }
      }
    }

    const last = res.messages[res.messages.length - 1];
    if (!last || typeof last.id !== "number") break;
    offsetId = last.id;
    // Early termination: exit if we've hit the limit or received fewer messages than requested
    if (res.messages.length < pageSize || totalFetched >= remainingCapacity) break;
  }

  if (more.length > 0) {
    more.sort((a, b) => a.id - b.id);
    const updated = cached.concat(more);
    historyCache.set(cacheKey, updated);
    
    const fetchDuration = Date.now() - fetchStartTime;
    console.log(
      `Incremental history update for ${cacheKey}: ${totalFetched} new messages in ${apiCalls} API calls (${fetchDuration}ms)`
    );
    
    return updated;
  }

  const fetchDuration = Date.now() - fetchStartTime;
  console.log(`History cache hit for ${cacheKey} (${fetchDuration}ms)`);
  return cached;
}

export async function messageHandler(event: NewMessageEvent): Promise<void> {
  try {
    const message = event.message;
    const client = (event as any)._client;

    if (!message) {
      console.log("No message in event, skipping");
      return;
    }

    const messageText = message.message;
    const senderId = (message.fromId as any)?.userId;
    const isOutgoing = message.out;

    if (!messageText || !senderId || !client || isOutgoing) {
      return;
    }

    if (await handleHumanOverrideMessage(message, client)) {
      return;
    }

    const senderIdString = senderId.toString();
    // Sanitize message text for logging to prevent exposure of sensitive data
    const sanitizedText = sanitizeMessageText(messageText, 100);
    console.log(`Received message from ${senderIdString}: "${sanitizedText}"`);

    // Only respond in private chats, or in groups when explicitly mentioned or replied to
    try {
      const allowed = await shouldRespondInContext(message, client);
      if (!allowed) {
        if (isPeerChatOrChannel(message?.peerId)) {
          console.log(
            `Skipping group message from ${senderIdString}: not mentioned or not a reply`
          );
        }
        return;
      }
    } catch {
      // On any detection error, default to not responding in group contexts
      if (!isPeerUser(message?.peerId)) {
        console.log(
          `Skipping group message from ${senderIdString}: mention/reply detection error`
        );
        return;
      }
    }

    recordInbound(senderIdString);

    // Supervisor contact logic: check mode and determine if supervisor should be contacted
    const chatIdRaw = isPeerChatOrChannel(message?.peerId) ? toIdString(message.peerId) : undefined;
    const chatId = chatIdRaw || undefined; // Convert null to undefined
    const peerKey = toIdString(message?.peerId);
    const conversationKey = chatId ?? peerKey ?? senderIdString;
    
    // Check if supervisor should be contacted based on mode
    const cfg = appConfig() as any;
    const supervisorMode = cfg?.supervisor?.mode || 'wake-up';
    const needsSupervisorContact = shouldContactSupervisor(senderIdString, chatId);

    // Resolve input peer early since we need it for history lookups
    let inputPeer: any = undefined;
    inputPeer = await resolveInputPeerSafe(client, message);

    // Build conversation context: full history with this user
    let context: ContextEntry[] = [];
    try {
      if (inputPeer) {
        context = await fetchFullHistory(client, inputPeer, conversationKey);
      }
    } catch (e) {
      console.error("Failed to build context:", e);
    }

    let personaRecord: any = null;
    let personaPrompt = appConfig().systemPrompt;
    try {
      personaRecord = await ensureChatPersonaRecord(conversationKey);
      if (personaRecord?.systemPrompt?.trim()) {
        personaPrompt = personaRecord.systemPrompt;
      }
    } catch (error) {
      console.warn(
        `Falling back to default persona for chat ${conversationKey}:`,
        (error as any)?.message || error,
      );
    }

    let llmContext: LLMContextEntry[] = [];
    // console.log("System Prompt:", personaPrompt);
    llmContext = convertContextToLLM(context, personaPrompt);

    // console.log("Context:", llmContext);

    const composeStartedAt = Date.now();

    // Contact supervisor if needed (based on mode: disabled/always/wake-up)
    if (supervisorMode !== 'disabled' && needsSupervisorContact) {
      const isAlwaysMode = supervisorMode === 'always';
      const overrideHandled = await attemptHumanOverride({
        client,
        message,
        inputPeer,
        senderIdString,
        chatId,
        conversationKey,
        personaRecord,
        llmContext,
        messageText: (messageText ?? "").toString(),
        isAlwaysMode,
        startedAt: composeStartedAt,
      });
      if (overrideHandled) {
        return;
      }
    }

    const replyText = await getResponse(llmContext) || "Ttyl xoxo";

    // inputPeer already resolved above; if not available, we still try to proceed

    // Phase 1: Apply reading delay (marks as read and waits)
    await applyReadingDelay(client, message, inputPeer);

    // Phase 2: Apply typing delay (shows typing indicator and waits)
    await applyTypingDelay(client, message, inputPeer);

    // Phase 3: Send reply using unified message sending function
    await sendMessageWithFallback({
      client,
      message,
      inputPeer,
      replyText,
      senderIdString,
      chatId,
      startedAt: composeStartedAt,
      personaRecord,
    });
    // TODO: Add logic to delete or end chat in some cases
  } catch (error) {
    // Critical error handler: log comprehensive error details and continue bot operation
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    
    // Extract context information safely
    let senderInfo = "unknown";
    let messagePreview = "unavailable";
    
    try {
      const message = event?.message;
      const senderId = (message?.fromId as any)?.userId;
      if (senderId) {
        senderInfo = senderId.toString();
      }
      
      const messageText = message?.message;
      if (messageText) {
        messagePreview = messageText.length > 100
          ? `${messageText.substring(0, 100)}...`
          : messageText;
      }
    } catch (extractError) {
      // If we can't extract context, continue with defaults
    }
    
    // Log comprehensive error information
    console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.error("❌ CRITICAL ERROR in messageHandler");
    console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.error(`Sender ID: ${senderInfo}`);
    console.error(`Message Preview: "${messagePreview}"`);
    console.error(`Error: ${errorMessage}`);
    if (errorStack) {
      console.error(`Stack Trace:\n${errorStack}`);
    }
    console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.error("Bot continues running...");
    console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    
    // Bot continues running - error is caught and logged but doesn't crash the process
  }
}
