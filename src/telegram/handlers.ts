// src/telegram/handlers.ts
import { NewMessage, NewMessageEvent } from "telegram/events";
import { CallbackQueryEvent } from "telegram/events/CallbackQuery";
import { Api } from "telegram";
import bigInt from "big-integer";
import { appConfig, randomInRange, sleep } from "../config";
import { getResponse, generateSampleReplies, ChatMessage } from "../llm/llm";
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

type ManualReviewResult = {
  responseText: string;
  via: "button" | "text";
  selectedIndex?: number;
  manualResponderId: string;
  manualResponderName?: string;
};

type ManualReviewRequest = {
  requestId: string;
  conversationKey: string;
  conversationLabel: string;
  manualPeer: any;
  manualPeerId: string;
  manualResponderName: string;
  sampleReplies: string[];
  messageId?: number;
  messageText: string;
  createdAt: number;
  timeout: NodeJS.Timeout;
  resolved: boolean;
  resolve: (result: ManualReviewResult | null) => void;
};

const MANUAL_CALLBACK_PREFIX = "wyatt_manual:";
const manualReviewRequests = new Map<string, ManualReviewRequest>();
const manualRequestsByConversation = new Map<string, string>();
const manualRequestsByMessageId = new Map<number, string>();
const knownManualResponderIds = new Set<string>();

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

function manualResponderIdentifier(): string {
  const raw = (appConfig() as any).manualResponderContact;
  return typeof raw === "string" ? raw.trim() : "";
}

function registerManualResponderId(id: string | null | undefined): void {
  if (!id) return;
  knownManualResponderIds.add(id);
}

function isManualResponderSender(senderId: string): boolean {
  if (!senderId) return false;
  if (knownManualResponderIds.has(senderId)) return true;
  const configured = manualResponderIdentifier();
  return configured !== "" && configured === senderId;
}

function truncateText(text: string, max = 600): string {
  const value = (text || "").trim();
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + "…";
}

function describeConversation(message: any, fallback: string): string {
  try {
    const chatTitle = (message as any)?.chat?.title ?? (message as any)?.peer?.title;
    if (chatTitle && String(chatTitle).trim()) {
      return String(chatTitle).trim();
    }
  } catch { }
  try {
    const sender = (message as any)?.sender;
    if (sender) {
      const first = (sender as any)?.firstName;
      const last = (sender as any)?.lastName;
      const username = (sender as any)?.username;
      const full = [first, last].filter(Boolean).join(" ").trim();
      if (full) return full;
      if (username) return `@${String(username)}`;
    }
  } catch { }
  return fallback;
}

function buildManualReviewMessage(options: {
  conversationLabel: string;
  senderId: string;
  messageText: string;
  wakeUpDelay: number;
  sampleReplies: string[];
}): string {
  const { conversationLabel, senderId, messageText, wakeUpDelay, sampleReplies } = options;
  const preview = truncateText(messageText, 800) || "(no text)";
  const seconds = Math.max(1, Math.round(wakeUpDelay / 1000));
  const samples = sampleReplies.map((reply, index) => `${index + 1}. ${reply}`).join("\n");
  return [
    "🛎️ Wake-up review needed",
    "",
    `Contact: ${conversationLabel}`,
    `Sender ID: ${senderId}`,
    "",
    "Latest message:",
    preview,
    "",
    `Pick a reply below or respond manually within ~${seconds}s. Reply directly to this message to send custom text.`,
    "",
    "Sample replies:",
    samples,
  ].join("\n");
}

function buildManualButtons(requestId: string, sampleReplies: string[]): any {
  return sampleReplies.map((_, index) => [
    {
      text: `Option ${index + 1}`,
      data: Buffer.from(`${MANUAL_CALLBACK_PREFIX}${requestId}:${index}`),
    },
  ]);
}

async function resolveManualResponderPeer(client: any): Promise<{ inputPeer: any; id: string; displayName: string } | null> {
  const identifier = manualResponderIdentifier();
  if (!identifier) return null;
  try {
    const entity = await client.getEntity(identifier);
    const inputPeer = await client.getInputEntity(entity);
    const id =
      toIdStringSafe((entity as any)?.id) ||
      toIdStringSafe((entity as any)?.userId) ||
      toIdStringSafe(inputPeer) ||
      identifier;
    const first = (entity as any)?.firstName;
    const last = (entity as any)?.lastName;
    const username = (entity as any)?.username;
    const fullName = [first, last].filter(Boolean).join(" ").trim();
    const displayName = fullName || (username ? `@${String(username)}` : id || identifier);
    registerManualResponderId(id);
    return { inputPeer, id: id || identifier, displayName };
  } catch (error) {
    console.warn(
      `Failed to resolve manual responder contact "${identifier}":`,
      (error as any)?.message || error,
    );
    return null;
  }
}

function extractReplyToId(message: any): number | null {
  try {
    const direct = (message as any)?.replyToMsgId;
    if (typeof direct === "number" && Number.isFinite(direct)) {
      return direct;
    }
  } catch { }
  try {
    const reply = (message as any)?.replyTo;
    const nested = (reply as any)?.replyToMsgId;
    if (typeof nested === "number" && Number.isFinite(nested)) {
      return nested;
    }
  } catch { }
  return null;
}

async function finalizeManualRequest(
  client: any,
  requestId: string,
  result: ManualReviewResult | null,
  statusText?: string,
): Promise<void> {
  const request = manualReviewRequests.get(requestId);
  if (!request || request.resolved) {
    return;
  }
  request.resolved = true;
  clearTimeout(request.timeout);
  manualReviewRequests.delete(requestId);
  manualRequestsByConversation.delete(request.conversationKey);
  if (typeof request.messageId === "number") {
    manualRequestsByMessageId.delete(request.messageId);
  }

  const updateText = statusText ? `${request.messageText}\n\n${statusText}` : request.messageText;
  if (typeof request.messageId === "number") {
    try {
      await client.editMessage(request.manualPeer, {
        message: request.messageId,
        text: updateText,
        buttons: [],
      });
    } catch (error) {
      console.warn(
        `Failed to update manual responder prompt message:`,
        (error as any)?.message || error,
      );
    }
  }

  if (result) {
    result.manualResponderName = result.manualResponderName ?? request.manualResponderName;
    result.manualResponderId = result.manualResponderId ?? request.manualPeerId;
  }

  request.resolve(result);
}

async function requestManualReview(options: {
  client: any;
  conversationKey: string;
  conversationLabel: string;
  senderIdString: string;
  messageText: string;
  sampleReplies: string[];
  wakeUpDelay: number;
  manualPeer: { inputPeer: any; id: string; displayName: string };
}): Promise<ManualReviewResult | null> {
  const {
    client,
    conversationKey,
    conversationLabel,
    senderIdString,
    messageText,
    sampleReplies,
    wakeUpDelay,
    manualPeer,
  } = options;

  if (!Array.isArray(sampleReplies) || sampleReplies.length === 0) {
    return null;
  }

  const existing = manualRequestsByConversation.get(conversationKey);
  if (existing) {
    await finalizeManualRequest(client, existing, null, "Superseded by a newer wake-up request.");
  }

  const requestId = `manual_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const messageBody = buildManualReviewMessage({
    conversationLabel,
    senderId: senderIdString,
    messageText,
    wakeUpDelay,
    sampleReplies,
  });

  let sentMessageId: number | undefined;
  try {
    const sent = await client.sendMessage(manualPeer.inputPeer, {
      message: messageBody,
      buttons: buildManualButtons(requestId, sampleReplies),
    });
    if (sent && typeof (sent as any).id === "number") {
      sentMessageId = (sent as any).id;
    }
  } catch (error) {
    console.warn(
      "Failed to send manual review request:",
      (error as any)?.message || error,
    );
    return null;
  }

  return await new Promise<ManualReviewResult | null>((resolve) => {
    const request: ManualReviewRequest = {
      requestId,
      conversationKey,
      conversationLabel,
      manualPeer: manualPeer.inputPeer,
      manualPeerId: manualPeer.id,
      manualResponderName: manualPeer.displayName,
      sampleReplies,
      messageId: sentMessageId,
      messageText: messageBody,
      createdAt: Date.now(),
      resolved: false,
      resolve,
      timeout: setTimeout(() => {
        finalizeManualRequest(
          client,
          requestId,
          null,
          "⏰ No manual reply received. Bot responded automatically.",
        ).catch(() => { });
      }, Math.max(1_000, wakeUpDelay)),
    };

    manualReviewRequests.set(requestId, request);
    manualRequestsByConversation.set(conversationKey, requestId);
    if (typeof sentMessageId === "number") {
      manualRequestsByMessageId.set(sentMessageId, requestId);
    }
  });
}

async function handleManualResponderMessage(message: any, client: any, senderId: string): Promise<void> {
  registerManualResponderId(senderId);
  const replyToId = extractReplyToId(message);
  if (!replyToId) {
    return;
  }
  const requestId = manualRequestsByMessageId.get(replyToId);
  if (!requestId) {
    return;
  }
  const text = (message?.message ?? "").toString().trim();
  if (!text) {
    return;
  }
  await finalizeManualRequest(
    client,
    requestId,
    {
      responseText: text,
      via: "text",
      manualResponderId: senderId,
    },
    "✍️ Custom reply sent to the contact.",
  );
}

type SendReplyOptions = {
  client: any;
  message: any;
  inputPeer: any;
  replyText: string;
  senderIdString: string;
  composeStartedAt: number;
  chatId: string | undefined;
  logLabel: string;
};

async function sendReplyWithTyping(options: SendReplyOptions): Promise<void> {
  const { client, message, inputPeer, replyText, senderIdString, composeStartedAt, chatId, logLabel } = options;
  const config = appConfig();
  const waitBefore = randomInRange(config.waitBeforeTypingMs.min, config.waitBeforeTypingMs.max);

  try {
    const peer = inputPeer || (await resolveInputPeerSafe(client, message)) || message.peerId;
    const maxId = (message as any)?.id || 0;
    if (peer && maxId) {
      await (client as any)
        .invoke(
          new Api.messages.ReadHistory({
            peer,
            maxId,
          }),
        )
        .catch(() => { });
    }
  } catch (error) {
    console.warn("Failed to mark message as read:", (error as any)?.message || error);
  }

  await sleep(waitBefore);

  const typingFor = randomInRange(config.typingDurationMs.min, config.typingDurationMs.max);
  const startTyping = () => {
    const peer = inputPeer || message.peerId;
    const sendTyping = () =>
      (client as any)
        .invoke(
          new Api.messages.SetTyping({
            peer,
            action: new Api.SendMessageTypingAction(),
          }),
        )
        .catch(() => { });

    sendTyping();
    const interval = setInterval(sendTyping, config.typingKeepaliveMs);

    return () => {
      clearInterval(interval);
      (client as any)
        .invoke(
          new Api.messages.SetTyping({
            peer,
            action: new Api.SendMessageCancelAction(),
          }),
        )
        .catch(() => { });
    };
  };

  const stopTyping = startTyping();
  await sleep(typingFor);

  let outboundRecorded = false;
  const textToSend = replyText || "";
  try {
    const isGroupContext = isPeerChatOrChannel(message?.peerId);
    const sendOptions: any = { message: textToSend };
    if (isGroupContext) {
      sendOptions.replyTo = (message as any).id;
    }
    await client.sendMessage(inputPeer || message.peerId, sendOptions);
    if (!outboundRecorded) {
      recordOutbound(senderIdString, Date.now() - composeStartedAt);
      outboundRecorded = true;
    }
    console.log(`Replied to ${senderIdString} (${logLabel}): "${textToSend}"`);
    updateLastInteraction(senderIdString, chatId);
  } catch (error) {
    console.error("Failed to send message:", error);
    try {
      const isGroupContext = isPeerChatOrChannel(message?.peerId);
      const sendParams: any = {
        peer: inputPeer || message.peerId,
        message: textToSend,
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
      console.log(`Replied via API to ${senderIdString} (${logLabel}): "${textToSend}"`);
      updateLastInteraction(senderIdString, chatId);
    } catch (apiError) {
      console.error("API fallback also failed:", apiError);
    }
  } finally {
    stopTyping();
  }
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

  if (!senderId || !client || isOutgoing) {
    return;
  }

  const senderIdString = senderId.toString();
  if (isManualResponderSender(senderIdString)) {
    await handleManualResponderMessage(message, client, senderIdString);
    return;
  }

  if (!messageText) {
    return;
  }
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

  const chatIdRaw = isPeerChatOrChannel(message?.peerId) ? toIdStringSafe(message.peerId) : undefined;
  const chatId = chatIdRaw || undefined;
  const peerKey = toIdStringSafe(message?.peerId);
  const conversationKey = chatId ?? peerKey ?? senderIdString;
  const conversationLabel = describeConversation(message, conversationKey);

  // Resolve input peer early since we need it for history lookups
  const inputPeer = await resolveInputPeerSafe(client, message);

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

  const llmContext = convertContextToLLM(context, personaPrompt);
  const llmChatMessages: ChatMessage[] = llmContext.map((entry) => ({
    role: entry.role,
    content: entry.content,
  }));

  // Wake up routine: check if bot has been inactive and needs to wake up
  const needsWakeUp = shouldWakeUp(senderIdString, chatId);

  if (needsWakeUp) {
    const wakeUpDelay = getWakeUpDelay();
    console.log(`🤖 Bot waking up after inactivity (~${Math.round(wakeUpDelay / 1000)}s delay)...`);
    const manualPeer = await resolveManualResponderPeer(client);
    let manualResult: ManualReviewResult | null = null;
    if (manualPeer) {
      try {
        const samples = await generateSampleReplies(llmChatMessages, 3);
        const started = Date.now();
        manualResult = await requestManualReview({
          client,
          conversationKey,
          conversationLabel,
          senderIdString,
          messageText: String(messageText ?? ""),
          sampleReplies: samples,
          wakeUpDelay,
          manualPeer,
        });
        if (!manualResult) {
          const elapsed = Date.now() - started;
          if (elapsed < wakeUpDelay) {
            await sleep(Math.max(0, wakeUpDelay - elapsed));
          }
        }
      } catch (error) {
        console.warn(
          "Manual wake override failed; falling back to automated response:",
          (error as any)?.message || error,
        );
        await sleep(wakeUpDelay);
      }
    } else {
      await sleep(wakeUpDelay);
    }
    console.log(`✅ Bot awake and ready to respond`);

    if (manualResult && manualResult.responseText) {
      const composeStartedAt = Date.now();
      const label = manualResult.manualResponderName
        ? `Manual override by ${manualResult.manualResponderName}`
        : "Manual override";
      await sendReplyWithTyping({
        client,
        message,
        inputPeer,
        replyText: manualResult.responseText,
        senderIdString,
        composeStartedAt,
        chatId,
        logLabel: label,
      });
      return;
    }
  }

  const composeStartedAt = Date.now();
  const replyText = await getResponse(llmContext) || "Ttyl xoxo";
  const personaLabel = formatPersonaLabel(personaRecord?.personaId || getDefaultPersonaId());

  await sendReplyWithTyping({
    client,
    message,
    inputPeer,
    replyText,
    senderIdString,
    composeStartedAt,
    chatId,
    logLabel: personaLabel,
  });
}

export async function callbackQueryHandler(event: CallbackQueryEvent): Promise<void> {
  const client = (event as any)._client;
  const dataBuffer = event.data;
  if (!client || !dataBuffer) {
    return;
  }

  let decoded = "";
  try {
    decoded = Buffer.from(dataBuffer).toString();
  } catch {
    return;
  }

  if (!decoded.startsWith(MANUAL_CALLBACK_PREFIX)) {
    return;
  }

  const payload = decoded.slice(MANUAL_CALLBACK_PREFIX.length);
  const [requestId, indexRaw] = payload.split(":");
  if (!requestId) {
    return;
  }

  const request = manualReviewRequests.get(requestId);
  if (!request || request.resolved) {
    await event.answer({ message: "This request has expired." }).catch(() => { });
    return;
  }

  const senderIdString = toIdStringSafe(event?.senderId);
  if (senderIdString) {
    registerManualResponderId(senderIdString);
    if (senderIdString !== request.manualPeerId) {
      await event.answer({ message: "You can't action this request." }).catch(() => { });
      return;
    }
  }

  const index = Number.parseInt(indexRaw ?? "", 10);
  if (!Number.isInteger(index) || index < 0 || index >= request.sampleReplies.length) {
    await event.answer({ message: "Unknown option." }).catch(() => { });
    return;
  }

  const responseText = request.sampleReplies[index];
  await finalizeManualRequest(
    client,
    requestId,
    {
      responseText,
      via: "button",
      selectedIndex: index,
      manualResponderId: request.manualPeerId,
      manualResponderName: request.manualResponderName,
    },
    `✅ Option ${index + 1} sent to ${request.conversationLabel}.`,
  );

  await event.answer({ message: "Sent to contact." }).catch(() => { });
}
