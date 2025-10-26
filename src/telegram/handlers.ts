// src/telegram/handlers.ts
import { NewMessage, NewMessageEvent } from "telegram/events";
import { CallbackQueryEvent } from "telegram/events/CallbackQuery";
import { Api } from "telegram";
import bigInt from "big-integer";
import { appConfig, randomInRange, sleep } from "../config";
import { getResponse, getResponseSuggestions } from "../llm/llm";
import { recordInbound, recordOutbound } from "../metrics";
import { ensureChatPersonaRecord, formatPersonaLabel, getDefaultPersonaId } from "./chatPersonality";
import type { ChatMessage } from "../llm/llm";


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

type WakeUpEscalationResult = {
  selected: string | null;
  timedOut: boolean;
  selectionIndex?: number;
};

type PendingEscalationRecord = {
  id: string;
  suggestions: string[];
  resolve: (result: WakeUpEscalationResult) => void;
  timeout: NodeJS.Timeout | null;
  resolved: boolean;
  requestText: string;
  manualPeer: any;
  manualMessageId?: number;
  client: any;
};

const pendingEscalations = new Map<string, PendingEscalationRecord>();
const manualPeerCache = new Map<string, any>();

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

function mapToChatMessages(entries: LLMContextEntry[]): ChatMessage[] {
  return entries.map((entry) => ({ role: entry.role, content: entry.content }));
}

async function resolveReviewerPeer(client: any, identifier: string): Promise<any | null> {
  if (!identifier) return null;
  if (manualPeerCache.has(identifier)) {
    return manualPeerCache.get(identifier);
  }
  try {
    const peer = await client.getInputEntity(identifier);
    manualPeerCache.set(identifier, peer);
    return peer;
  } catch (error) {
    console.warn("Wake-up escalation: failed to resolve reviewer chat:", (error as any)?.message || error);
    return null;
  }
}

function describeSenderName(message: any, fallback: string): string {
  try {
    const sender = (message as any)?.sender;
    const pieces: string[] = [];
    if (sender) {
      if (typeof sender.firstName === "string" && sender.firstName.trim()) pieces.push(sender.firstName.trim());
      if (typeof sender.lastName === "string" && sender.lastName.trim()) pieces.push(sender.lastName.trim());
      if (pieces.length === 0 && typeof sender.username === "string" && sender.username.trim()) return sender.username.trim();
      if (pieces.length === 0 && typeof sender.title === "string" && sender.title.trim()) return sender.title.trim();
      if (pieces.length > 0) return pieces.join(" ");
    }
  } catch { }
  return fallback;
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

async function maybeHandleWakeUpEscalation(params: {
  client: any;
  message: any;
  senderIdString: string;
  chatId?: string;
  llmContext: LLMContextEntry[];
  delayMs: number;
  incomingText: string;
}): Promise<WakeUpEscalationResult> {
  const { client, message, senderIdString, chatId, llmContext, delayMs, incomingText } = params;
  const config = appConfig() as any;
  const reviewerId = typeof config.wakeUpEscalationChatId === "string" ? config.wakeUpEscalationChatId.trim() : "";
  const reviewerLabel = typeof config.wakeUpEscalationLabel === "string" ? config.wakeUpEscalationLabel.trim() : "";
  const suggestionCountRaw = Number(config.wakeUpSuggestionCount);
  const suggestionCount = Number.isFinite(suggestionCountRaw)
    ? Math.min(6, Math.max(1, Math.trunc(suggestionCountRaw)))
    : 3;

  if (!reviewerId) {
    if (delayMs > 0) await sleep(delayMs);
    return { selected: null, timedOut: true };
  }

  const manualPeer = await resolveReviewerPeer(client, reviewerId);
  if (!manualPeer) {
    if (delayMs > 0) await sleep(delayMs);
    return { selected: null, timedOut: true };
  }

  let suggestions: string[] = [];
  try {
    const chatMessages: ChatMessage[] = mapToChatMessages(llmContext);
    suggestions = await getResponseSuggestions(chatMessages, { count: suggestionCount });
  } catch (error) {
    console.warn("Wake-up escalation: suggestion generation failed:", (error as any)?.message || error);
  }

  if (suggestions.length === 0) {
    try {
      const fallback = await getResponse(llmContext);
      if (fallback && fallback.trim()) {
        suggestions = [fallback.trim()];
      }
    } catch (error) {
      console.warn("Wake-up escalation: fallback reply generation failed:", (error as any)?.message || error);
    }
  }

  if (suggestions.length === 0) {
    suggestions = ["Let me shake off the cobwebs and get right back to you! 😊"];
  }

  const requestId = `wake_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const senderLabel = describeSenderName(message, senderIdString);
  const preview = (incomingText || "").trim();
  const truncatedMessage = preview.length > 900 ? `${preview.slice(0, 897)}…` : preview || "(no text content)";
  const seconds = Math.max(1, Math.round(delayMs / 1000));
  const header = reviewerLabel
    ? `Hey ${reviewerLabel}, the bot just got pinged after a long nap.`
    : "Wake-up alert: the bot just got pinged after a long nap.";
  const bodyLines = [
    header,
    `From: ${senderLabel} (${senderIdString})`,
    chatId ? `Chat key: ${chatId}` : null,
    "",
    "Message received:",
    truncatedMessage,
    "",
    "Suggested replies:",
    ...suggestions.map((text, idx) => `${idx + 1}. ${text}`),
    "",
    `Tap a button below to send one. The bot will respond automatically in ~${seconds}s if no option is chosen.`,
  ].filter((line): line is string => line !== null);
  const requestText = bodyLines.join("\n");

  const buttons = suggestions.map((_, idx) => [
    new Api.KeyboardButtonCallback({
      text: `Send option ${idx + 1}`,
      data: Buffer.from(JSON.stringify({ t: "wake", id: requestId, idx }), "utf8"),
    }),
  ]);
  buttons.push([
    new Api.KeyboardButtonCallback({
      text: "Let bot reply",
      data: Buffer.from(JSON.stringify({ t: "wake", id: requestId, idx: -1 }), "utf8"),
    }),
  ]);

  let manualMessage: any;
  try {
    manualMessage = await client.sendMessage(manualPeer, {
      message: requestText,
      buttons,
    });
    console.log(`Forwarded wake-up alert to reviewer ${reviewerId} for ${senderIdString}.`);
  } catch (error) {
    console.warn("Wake-up escalation: failed to notify reviewer:", (error as any)?.message || error);
    if (delayMs > 0) await sleep(delayMs);
    return { selected: null, timedOut: true };
  }

  return await new Promise<WakeUpEscalationResult>((resolvePromise) => {
    const record: PendingEscalationRecord = {
      id: requestId,
      suggestions,
      resolve: () => { },
      timeout: null,
      resolved: false,
      requestText,
      manualPeer,
      manualMessageId: manualMessage?.id,
      client,
    };

    record.resolve = (result: WakeUpEscalationResult) => {
      if (record.resolved) return;
      record.resolved = true;
      if (record.timeout) clearTimeout(record.timeout);
      pendingEscalations.delete(requestId);
      resolvePromise(result);
    };

    record.timeout = setTimeout(async () => {
      if (record.resolved) return;
      record.resolved = true;
      pendingEscalations.delete(requestId);
      if (record.manualMessageId) {
        try {
          await client.editMessage(manualPeer, {
            message: record.manualMessageId,
            text: `${requestText}\n\n⌛ Bot replied automatically.`,
            buttons: [],
          });
        } catch { }
      }
      resolvePromise({ selected: null, timedOut: true });
    }, Math.max(0, delayMs));

    pendingEscalations.set(requestId, record);
  });
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

type DeliverReplyParams = {
  replyText: string;
  client: any;
  message: any;
  inputPeer: any;
  senderIdString: string;
  composeStartedAt: number;
  chatId?: string;
  personaRecord?: any;
  useDelays: boolean;
  manualOverride?: boolean;
  manualSelectionIndex?: number;
};

async function deliverReply({
  replyText,
  client,
  message,
  inputPeer,
  senderIdString,
  composeStartedAt,
  chatId,
  personaRecord,
  useDelays,
  manualOverride,
  manualSelectionIndex,
}: DeliverReplyParams): Promise<void> {
  const isGroupContext = isPeerChatOrChannel(message?.peerId);
  const waitBefore = useDelays
    ? randomInRange(appConfig().waitBeforeTypingMs.min, appConfig().waitBeforeTypingMs.max)
    : 0;
  const typingDuration = useDelays
    ? randomInRange(appConfig().typingDurationMs.min, appConfig().typingDurationMs.max)
    : 0;

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
  } catch (error) {
    console.warn("Failed to mark message as read:", (error as any)?.message || error);
  }

  if (waitBefore > 0) {
    await sleep(waitBefore);
  }

  let stopTyping: () => void = () => { };
  if (useDelays && typingDuration > 0) {
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
    stopTyping = startTyping();
    await sleep(typingDuration);
  }

  let outboundRecorded = false;
  try {
    const sendOptions: any = { message: replyText };
    if (isGroupContext) {
      sendOptions.replyTo = (message as any).id;
    }
    await client.sendMessage(inputPeer || message.peerId, sendOptions);
    if (!outboundRecorded) {
      recordOutbound(senderIdString, Date.now() - composeStartedAt);
      outboundRecorded = true;
    }
    const personaLabel = formatPersonaLabel(personaRecord?.personaId || getDefaultPersonaId());
    const prefix = manualOverride ? "Manual override reply" : "Replied";
    const optionNote = manualOverride && typeof manualSelectionIndex === "number"
      ? ` (option ${manualSelectionIndex + 1})`
      : "";
    console.log(`${prefix}${optionNote} to ${senderIdString} using ${personaLabel}: "${replyText}"`);
    updateLastInteraction(senderIdString, chatId);
  } catch (error) {
    console.error("Failed to send message:", error);
    try {
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
      const personaLabel = formatPersonaLabel(personaRecord?.personaId || getDefaultPersonaId());
      const prefix = manualOverride ? "Manual override reply" : "Replied";
      const optionNote = manualOverride && typeof manualSelectionIndex === "number"
        ? ` (option ${manualSelectionIndex + 1})`
        : "";
      console.log(`${prefix}${optionNote} via API to ${senderIdString} using ${personaLabel}: "${replyText}"`);
      updateLastInteraction(senderIdString, chatId);
    } catch (apiError) {
      console.error("API fallback also failed:", apiError);
    }
  } finally {
    try {
      stopTyping();
    } catch { }
  }
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
    console.log(`🤖 Bot waking up after inactivity (${Math.round(wakeUpDelay / 1000)}s delay)...`);
    try {
      const escalationResult = await maybeHandleWakeUpEscalation({
        client,
        message,
        senderIdString,
        chatId,
        llmContext,
        delayMs: wakeUpDelay,
        incomingText: messageText,
      });
      if (escalationResult.selected) {
        await deliverReply({
          replyText: escalationResult.selected,
          client,
          message,
          inputPeer,
          senderIdString,
          composeStartedAt,
          chatId,
          personaRecord,
          useDelays: false,
          manualOverride: true,
          manualSelectionIndex: escalationResult.selectionIndex,
        });
        return;
      }
      if (escalationResult.timedOut) {
        console.log(`✅ Bot awake and ready to respond`);
      } else {
        console.log(`Reviewer opted to let the bot reply automatically.`);
      }
    } catch (error) {
      console.warn("Wake-up escalation failed, continuing with automated reply:", (error as any)?.message || error);
      if (wakeUpDelay > 0) {
        await sleep(wakeUpDelay);
      }
      console.log(`✅ Bot awake and ready to respond`);
    }
  }

  const replyText = (await getResponse(llmContext)) || "Ttyl xoxo";

  await deliverReply({
    replyText,
    client,
    message,
    inputPeer,
    senderIdString,
    composeStartedAt,
    chatId,
    personaRecord,
    useDelays: true,
  });
  // TODO: Add logic to delete or end chat in some cases
}

export async function callbackQueryHandler(event: CallbackQueryEvent): Promise<void> {
  const dataRaw = event.data;
  if (!dataRaw) return;

  let payload: any;
  try {
    payload = JSON.parse(dataRaw.toString());
  } catch {
    return;
  }

  if (!payload || payload.t !== "wake" || typeof payload.id !== "string") {
    return;
  }

  const record = pendingEscalations.get(payload.id);
  if (!record) {
    try { await event.answer({ message: "Request already handled.", cacheTime: 0 }); } catch { }
    return;
  }

  const selectionIndex = typeof payload.idx === "number" ? payload.idx : -1;

  if (selectionIndex >= 0 && selectionIndex < record.suggestions.length) {
    const replyText = record.suggestions[selectionIndex];
    record.resolve({ selected: replyText, timedOut: false, selectionIndex });
    try { await event.answer({ message: "Sending selected reply…", cacheTime: 0 }); } catch { }
    try {
      await event.edit({
        message: record.manualMessageId ?? event.messageId,
        text: `${record.requestText}\n\n✅ Sent option ${selectionIndex + 1}.`,
        buttons: [],
      });
    } catch { }
  } else {
    record.resolve({ selected: null, timedOut: false });
    try { await event.answer({ message: "Letting the bot reply automatically.", cacheTime: 0 }); } catch { }
    try {
      await event.edit({
        message: record.manualMessageId ?? event.messageId,
        text: `${record.requestText}\n\n⏭️ Letting the bot reply automatically.`,
        buttons: [],
      });
    } catch { }
  }
}
