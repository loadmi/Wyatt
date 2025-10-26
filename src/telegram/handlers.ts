// src/telegram/handlers.ts
import { NewMessage, NewMessageEvent } from "telegram/events";
import { Api } from "telegram";
import bigInt from "big-integer";
import { appConfig, randomInRange, sleep } from "../config";
import { getResponse, getSuggestedReplies } from "../llm/llm";
import { recordInbound, recordOutbound } from "../metrics";
import { ensureChatPersonaRecord, formatPersonaLabel, getDefaultPersonaId } from "./chatPersonality";


// Simple in-memory cache of fetched histories per user to avoid re-fetching
// the entire history on every message. Updated lazily when accessed.
type ContextEntry = {
  id: number;
  date: number;
  from: "user" | "me";
  text: string;
};
const historyCache = new Map<string, ContextEntry[]>();

const FALLBACK_SUGGESTIONS = [
  "Oh goodness, that's quite something—should I keep them chatting?",
  "Let me play along a bit—how about I ask for more details?",
  "I can stall them a little longer. Want me to stay curious?",
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
  suggestions: string[];
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

// Cached self info to detect mentions/replies in group chats
let selfUsernameCached: string | null = null;
let selfIdStringCached: string | null = null;

// Wake up routine: track last interaction time per user/chat
type InteractionRecord = {
   lastInteraction: number; // timestamp
   chatId: string; // to distinguish between different chats
 };

// Load persisted interaction tracker data
function loadInteractionTracker(): Map<string, InteractionRecord> {
   try {
     const { loadPersistedState } = require("../persistence");
     const persisted = loadPersistedState();
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

const interactionTracker = loadInteractionTracker();

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
  return timeSinceLastInteraction > appConfig().sleepThresholdMs;
}

// Helper function to save interaction tracker to persistence
function saveInteractionTracker(): void {
   try {
     const { savePersistedState } = require("../persistence");
     const data: Record<string, InteractionRecord> = {};
     interactionTracker.forEach((record, key) => {
       data[key] = record;
     });
     savePersistedState({ interactionTracker: data });
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
  return randomInRange(config.wakeUpDelayMs.min, config.wakeUpDelayMs.max);
}

function getConfiguredHumanTarget(): string | null {
  const cfg = appConfig() as any;
  const raw = cfg?.humanEscalationChatId;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
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
      const key = toIdStringSafe(entity) || toIdStringSafe((entity as any)?.peer) || toIdStringSafe(query) || target;
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

  const peerKey = toIdStringSafe(message?.peerId);
  const senderKey = toIdStringSafe((message?.fromId as any)?.userId);
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

function parseHumanResponse(raw: string, suggestions: string[]): ParsedHumanResponse | null {
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
        if (typeof suggestion === "string" && suggestion.trim()) {
          return { kind: "suggestion", index: idx - 1, text: suggestion.trim() };
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

function toIdStringSafe(x: any): string | null {
  try {
    if (x === null || x === undefined) return null;
    if (typeof x === "string" || typeof x === "number" || typeof x === "bigint") return String(x);
    // Prefer explicit peer identifiers first so groups/channels use numeric IDs
    if (x?.channelId !== undefined) return toIdStringSafe(x.channelId);
    if (x?.chatId !== undefined) return toIdStringSafe(x.chatId);
    if (x?.userId !== undefined) return toIdStringSafe(x.userId);
    if (x?.id !== undefined) return toIdStringSafe(x.id);
    if (x?.value !== undefined) return toIdStringSafe(x.value);
    if (typeof x.toString === "function") {
      const s = x.toString();
      return s && s !== "[object Object]" ? String(s) : null;
    }
  } catch { }
  return null;
}

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
          const entUserIdStr = toIdStringSafe((ent as any).userId);
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
export function convertContextToLLM(context: ContextEntry[], systemPrompt?: string): LLMContextEntry[] {
  const mapped: LLMContextEntry[] = context.map((m) => ({
    role: m.from === "me" ? "assistant" : "user",
    content: m.text,
  }));

  if (systemPrompt && systemPrompt.trim().length > 0) {
    return [{ role: "system", content: systemPrompt.trim() }, ...mapped];
  }
  return mapped;
}

async function handleHumanOverrideMessage(message: any, client: any): Promise<boolean> {
  const configured = getConfiguredHumanTarget();
  if (!configured) return false;

  const override = findPendingOverrideForMessage(message);
  const peerKey = toIdStringSafe(message?.peerId);
  const senderKey = toIdStringSafe((message?.fromId as any)?.userId);
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
        message: `Please choose 1-${override.suggestions.length} or type a custom reply to forward.`,
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
  const trimmed = (replyText || "").trim();
  if (!trimmed) {
    console.warn("Manual override produced an empty reply; skipping send.");
    return false;
  }

  let outboundRecorded = false;
  try {
    const isGroupContext = isPeerChatOrChannel(message?.peerId);
    const sendOptions: any = { message: trimmed };
    if (isGroupContext) {
      sendOptions.replyTo = (message as any).id;
    }
    await client.sendMessage(inputPeer || message.peerId, sendOptions);
    recordOutbound(senderIdString, Date.now() - startedAt);
    outboundRecorded = true;
    console.log(
      `✅ Wake-up override reply sent to ${senderIdString} using ${formatPersonaLabel(
        personaRecord?.personaId || getDefaultPersonaId(),
      )}: "${trimmed}"`,
    );
    updateLastInteraction(senderIdString, chatId);
    return true;
  } catch (error) {
    console.error("Failed to send manual override message:", error);
  }

  try {
    const isGroupContext = isPeerChatOrChannel(message?.peerId);
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
      `✅ Wake-up override reply sent via API to ${senderIdString} using ${formatPersonaLabel(
        personaRecord?.personaId || getDefaultPersonaId(),
      )}: "${trimmed}"`,
    );
    updateLastInteraction(senderIdString, chatId);
    return true;
  } catch (apiError) {
    console.error("Manual override API fallback failed:", apiError);
  }

  return false;
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
  wakeUpDelay: number;
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
    wakeUpDelay,
    startedAt,
  } = params;

  console.log(`🤖 Bot waking up after inactivity (${Math.max(1, Math.round(wakeUpDelay / 1000))}s delay)...`);

  const target = getConfiguredHumanTarget();
  if (!target) {
    await sleep(wakeUpDelay);
    console.log("✅ Bot awake and ready to respond");
    return false;
  }

  const humanPeer = await resolveHumanPeer(client);
  if (!humanPeer) {
    await sleep(wakeUpDelay);
    console.log("✅ Bot awake and ready to respond");
    return false;
  }

  let suggestions: string[] = [];
  try {
    suggestions = await getSuggestedReplies(llmContext, 3);
  } catch (error) {
    console.warn("Failed to generate wake-up suggestions:", (error as any)?.message || error);
  }
  suggestions = suggestions
    .filter((entry) => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
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

  const prettyDelay = Math.max(1, Math.round(wakeUpDelay / 1000));
  const overrideId = `wake_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const suggestionLines = suggestions.map((entry, idx) => `${idx + 1}. ${entry}`).join("\n");
  const notification = [
    `Wake-up override requested (${overrideId}).`,
    `Contact: ${senderIdString}${chatId ? ` · Chat ${chatId}` : ""}`,
    `Message:`,
    truncatedMessage,
    ``,
    `Suggestions:`,
    suggestionLines,
    ``,
    `Reply within ~${prettyDelay}s by tapping a button or sending your own text.`,
  ].join("\n");

  const buttonRows = suggestions.map((_, idx) => [`Send ${idx + 1}`]);
  buttonRows.push(["Ignore"]);

  let sent: any;
  try {
    sent = await client.sendMessage(humanPeer.input, { message: notification, buttons: buttonRows });
  } catch (error) {
    console.warn("Failed to notify wake-up supervisor:", (error as any)?.message || error);
    await sleep(wakeUpDelay);
    console.log("✅ Bot awake and ready to respond");
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
      expiresAt: Date.now() + wakeUpDelay,
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

  const timerPromise = sleep(wakeUpDelay).then<HumanOverrideDecision>(() => ({
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
      try {
        const ack = decision.fromSuggestion && typeof decision.index === "number"
          ? `✅ Sent suggestion ${decision.index}. Thank you!`
          : "✅ Sent your reply to the contact. Thank you!";
        await client.sendMessage(humanPeer.input, { message: ack });
      } catch { }
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
    console.log("👋 Manual wake-up override skipped by supervisor; continuing automated reply.");
    return false;
  }

  try {
    await client.sendMessage(humanPeer.input, {
      message: "⏰ No selection received. Resuming the automated reply.",
    });
  } catch { }
  console.log("⌛ Manual wake-up override timed out; falling back to automated response.");
  console.log("✅ Bot awake and ready to respond");
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
// Note: This may be expensive for very long chats. We cache results per user id.
async function fetchFullHistory(client: any, peer: any, cacheKey: string): Promise<ContextEntry[]> {
  const cached = historyCache.get(cacheKey);
  const pageSize = 100;

  // Fresh fetch if nothing cached yet
  if (!cached || cached.length === 0) {
    const all: ContextEntry[] = [];
    let offsetId = 0;
    while (true) {
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
        }
      }

      const last = res.messages[res.messages.length - 1];
      if (!last || typeof last.id !== "number") break;
      offsetId = last.id;
      if (res.messages.length < pageSize) break;
    }

    all.sort((a, b) => a.id - b.id);
    historyCache.set(cacheKey, all);
    return all;
  }

  // Incremental update: fetch only messages newer than the last cached id
  const lastKnownId = cached[cached.length - 1]?.id || 0;
  let more: ContextEntry[] = [];
  let offsetId = 0;
  while (true) {
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
        }
      }
    }

    const last = res.messages[res.messages.length - 1];
    if (!last || typeof last.id !== "number") break;
    offsetId = last.id;
    if (res.messages.length < pageSize) break;
  }

  if (more.length > 0) {
    more.sort((a, b) => a.id - b.id);
    const updated = cached.concat(more);
    historyCache.set(cacheKey, updated);
    return updated;
  }

  return cached;
}

export async function messageHandler(event: NewMessageEvent): Promise<void> {
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
  console.log(`Received message from ${senderIdString}: "${messageText}"`);

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

  // Wake up routine: check if bot has been inactive and needs to wake up
  const chatIdRaw = isPeerChatOrChannel(message?.peerId) ? toIdStringSafe(message.peerId) : undefined;
  const chatId = chatIdRaw || undefined; // Convert null to undefined
  const peerKey = toIdStringSafe(message?.peerId);
  const conversationKey = chatId ?? peerKey ?? senderIdString;
  const needsWakeUp = shouldWakeUp(senderIdString, chatId);

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

  if (needsWakeUp) {
    const wakeUpDelay = getWakeUpDelay();
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
      wakeUpDelay,
      startedAt: composeStartedAt,
    });
    if (overrideHandled) {
      return;
    }
  }

  const replyText = await getResponse(llmContext) || "Ttyl xoxo";

  // inputPeer already resolved above; if not available, we still try to proceed

  // Centralized typing indicator control
  const startTyping = () => {
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
    const interval = setInterval(sendTyping, appConfig().typingKeepaliveMs);

    return () => {
      clearInterval(interval);
      (client as any)
        .invoke(
          new Api.messages.SetTyping({
            peer,
            action: new Api.SendMessageCancelAction(),
          })
        )
        .catch(() => { });
    };
  };

  // Phase 1: silent wait before typing
  const waitBefore = randomInRange(
    appConfig().waitBeforeTypingMs.min,
    appConfig().waitBeforeTypingMs.max
  );
  // Mark the incoming message as read right before starting the wait timer
  try {
    const peer = inputPeer || (await resolveInputPeerSafe(client, message)) || message.peerId;
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

  // Phase 2: show typing for configured duration
  const typingFor = randomInRange(
    appConfig().typingDurationMs.min,
    appConfig().typingDurationMs.max
  );
  const stopTyping = startTyping();
  await sleep(typingFor);

  // Phase 3: send reply and stop typing
  let outboundRecorded = false;
  try {
    const isGroupContext = isPeerChatOrChannel(message?.peerId);
    const sendOptions: any = { message: replyText };
    if (isGroupContext) {
      sendOptions.replyTo = (message as any).id;
    }
    await client.sendMessage(inputPeer || message.peerId, sendOptions);

    if (!outboundRecorded) {
      recordOutbound(senderIdString, Date.now() - composeStartedAt);
      outboundRecorded = true;
    }
    console.log(`Replied to ${senderIdString} using ${formatPersonaLabel(personaRecord?.personaId || getDefaultPersonaId())}: "${replyText}"`);

    // Update last interaction time after successful response
    updateLastInteraction(senderIdString, chatId);
  } catch (error) {
    console.error("Failed to send message:", error);

    // Fallback: try using the API directly
    try {
      const isGroupContext = isPeerChatOrChannel(message?.peerId);
      const sendParams: any = {
        peer: inputPeer || message.peerId,
        message: replyText,
        randomId: bigInt(Math.floor(Math.random() * 1e16)),
      };
      if (isGroupContext) {
        sendParams.replyTo = new Api.InputReplyToMessage({ replyToMsgId: (message as any).id });
      }
      await client.invoke(new Api.messages.SendMessage(sendParams));
      if (!outboundRecorded) {
        recordOutbound(senderIdString, Date.now() - composeStartedAt);
        outboundRecorded = true;
      }
      console.log(`Replied via API to ${senderIdString} using ${formatPersonaLabel(personaRecord?.personaId || getDefaultPersonaId())}: "${replyText}"`);

      // Update last interaction time after successful response
      updateLastInteraction(senderIdString, chatId);
    } catch (apiError) {
      console.error("API fallback also failed:", apiError);
    }
  } finally {
    stopTyping();
  }
  // TODO: Add logic to delete or end chat in some cases
}
