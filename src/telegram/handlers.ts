// src/telegram/handlers.ts
import { NewMessage, NewMessageEvent } from "telegram/events";
import { CallbackQueryEvent } from "telegram/events/CallbackQuery";
import { Api } from "telegram";
import bigInt from "big-integer";
import { appConfig, randomInRange, sleep } from "../config";
import { generateSampleReplies, getResponse } from "../llm/llm";
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

type ManualOption = {
  id: string;
  text: string;
  label: string;
};

type ManualIntervention = {
  token: string;
  conversationKey: string;
  manualResponderId: string | null;
  manualPeer: any;
  originalPeer: any;
  originalMessageId: number;
  originalSenderId: string;
  chatId?: string;
  isGroup: boolean;
  options: ManualOption[];
  createdAt: number;
  expiresAt: number;
  responded: boolean;
  respondedAt?: number;
  responseText?: string;
  composeStartedAt: number;
  personaLabel?: string;
};

const manualInterventions = new Map<string, ManualIntervention>();
const manualConversationIndex = new Map<string, string>();

const MANUAL_FALLBACK_OPTIONS = [
  "Oh goodness, just seeing this now—did you still need me?",
  "Hey there stranger, sorry I nodded off for a bit. What’s the latest?",
  "I’m awake! Give granny a hint about what’s going on again?",
];

function generateManualToken(): string {
  return `mw_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function getManualResponderTarget(): string | null {
  const raw = (appConfig() as any).manualResponderChatId;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function truncateForPreview(text: string, max = 600): string {
  const value = (text || "").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function cleanupManualIntervention(token: string): ManualIntervention | undefined {
  const entry = manualInterventions.get(token);
  if (!entry) return undefined;
  manualInterventions.delete(token);
  manualConversationIndex.delete(entry.conversationKey);
  return entry;
}

export function resetManualInterventions(): void {
  manualInterventions.clear();
  manualConversationIndex.clear();
}

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

type ManualInterventionParams = {
  client: any;
  conversationKey: string;
  senderIdString: string;
  messageText: string;
  personaLabel?: string;
  llmContext: LLMContextEntry[];
  autoReplyText: string;
  wakeUpDelayMs: number;
  originalPeer: any;
  originalMessageId: number;
  isGroup: boolean;
  chatId?: string;
  composeStartedAt: number;
};

function canonicalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

async function maybeStartManualIntervention(params: ManualInterventionParams): Promise<ManualIntervention | null> {
  const manualTarget = getManualResponderTarget();
  if (!manualTarget) {
    return null;
  }

  const client = params.client;
  let manualPeer: any;
  try {
    manualPeer = await client.getInputEntity(manualTarget);
  } catch (error) {
    console.warn(
      `Failed to resolve manual responder target "${manualTarget}":`,
      (error as any)?.message || error,
    );
    return null;
  }

  const manualResponderId = toIdStringSafe(manualPeer) || manualTarget;

  const existingToken = manualConversationIndex.get(params.conversationKey);
  if (existingToken) {
    cleanupManualIntervention(existingToken);
  }

  const token = generateManualToken();
  const desiredOptions = 3;
  const defaultReply = (params.autoReplyText || "").trim();
  const suggestions = await generateSampleReplies(params.llmContext, desiredOptions).catch(() => []);
  const unique: string[] = [];
  const seen = new Set<string>();

  const pushOption = (text: string) => {
    const trimmed = (text || "").trim();
    if (!trimmed) return;
    const key = canonicalize(trimmed);
    if (seen.has(key)) return;
    seen.add(key);
    unique.push(trimmed);
  };

  if (defaultReply) {
    pushOption(defaultReply);
  }

  for (const suggestion of suggestions) {
    if (unique.length >= desiredOptions) break;
    pushOption(suggestion);
  }

  for (const fallback of MANUAL_FALLBACK_OPTIONS) {
    if (unique.length >= desiredOptions) break;
    pushOption(fallback);
  }

  if (unique.length === 0) {
    pushOption("Still here! Mind catching me up again?");
  }

  const selected = unique.slice(0, desiredOptions);
  const manualOptions: ManualOption[] = selected.map((text, index) => {
    const isDefault = defaultReply && canonicalize(text) === canonicalize(defaultReply);
    const label = isDefault ? "Send default" : `Send option ${index + 1}`;
    return {
      id: `manual|${token}|${index}`,
      text,
      label,
    };
  });

  const seconds = Math.max(5, Math.round(params.wakeUpDelayMs / 1000));
  const preview = truncateForPreview(params.messageText, 800);
  const personaLine = params.personaLabel ? `Persona: ${params.personaLabel}` : null;
  const optionSummary = manualOptions
    .map((opt, index) => `${index + 1}. ${opt.text}`)
    .join("\n\n");

  const messageLines = [
    "🛎️ Wake-up override requested",
    `Contact: ${params.senderIdString}`,
  ];
  if (personaLine) {
    messageLines.push(personaLine);
  }
  if (preview) {
    messageLines.push("");
    messageLines.push(`Message received:\n${preview}`);
  }
  messageLines.push("");
  messageLines.push("Suggested replies:");
  messageLines.push(optionSummary);
  messageLines.push("");
  messageLines.push(
    `Choose a button below within ${seconds}s to forward a manual reply. If you do nothing, the bot will respond automatically.`,
  );

  const rows = manualOptions.map((opt) =>
    new Api.KeyboardButtonRow({
      buttons: [
        new Api.KeyboardButtonCallback({
          text: opt.label,
          data: Buffer.from(opt.id),
        }),
      ],
    }),
  );

  try {
    await client.sendMessage(manualPeer, {
      message: messageLines.join("\n"),
      buttons: new Api.ReplyInlineMarkup({ rows }),
    });
  } catch (error) {
    console.warn(
      `Failed to send manual intervention prompt to ${manualResponderId}:`,
      (error as any)?.message || error,
    );
    return null;
  }

  const intervention: ManualIntervention = {
    token,
    conversationKey: params.conversationKey,
    manualResponderId,
    manualPeer,
    originalPeer: params.originalPeer,
    originalMessageId: params.originalMessageId,
    originalSenderId: params.senderIdString,
    chatId: params.chatId,
    isGroup: params.isGroup,
    options: manualOptions,
    createdAt: Date.now(),
    expiresAt: Date.now() + params.wakeUpDelayMs,
    responded: false,
    composeStartedAt: params.composeStartedAt,
    personaLabel: params.personaLabel,
  };

  manualInterventions.set(token, intervention);
  manualConversationIndex.set(params.conversationKey, token);

  console.log(
    `Escalation prompt sent to ${manualResponderId} for contact ${params.senderIdString}. Options: ${manualOptions.length}`,
  );

  return intervention;
}

async function notifyManualInterventionExpired(
  intervention: ManualIntervention,
  client: any,
  autoReplyText: string,
): Promise<void> {
  try {
    const preview = truncateForPreview(autoReplyText, 200);
    const message = preview
      ? `⏰ No manual reply was selected for ${intervention.originalSenderId}. Sent automated response instead:\n${preview}`
      : `⏰ No manual reply was selected for ${intervention.originalSenderId}. Sent automated response instead.`;
    await client.sendMessage(intervention.manualPeer, { message });
  } catch (error) {
    console.warn("Failed to send manual escalation timeout notice:", (error as any)?.message || error);
  }
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
  const replyText = await getResponse(llmContext) || "Ttyl xoxo";
  const personaLabel = formatPersonaLabel(personaRecord?.personaId || getDefaultPersonaId());

  // Mark the incoming message as read before any additional waiting
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

  const isGroupContext = isPeerChatOrChannel(message?.peerId);
  let wakeUpDelay = 0;
  let manualIntervention: ManualIntervention | null = null;
  if (needsWakeUp) {
    wakeUpDelay = getWakeUpDelay();
    manualIntervention = await maybeStartManualIntervention({
      client,
      conversationKey,
      senderIdString,
      messageText: typeof messageText === "string" ? messageText : String(messageText ?? ""),
      personaLabel,
      llmContext,
      autoReplyText: replyText,
      wakeUpDelayMs: wakeUpDelay,
      originalPeer: inputPeer || message.peerId,
      originalMessageId: Number((message as any)?.id) || 0,
      isGroup: isGroupContext,
      chatId,
      composeStartedAt,
    });

    console.log(`🤖 Bot waking up after inactivity (${Math.round(wakeUpDelay / 1000)}s delay)...`);
    await sleep(wakeUpDelay);
    console.log(`✅ Bot awake and ready to respond`);

    if (manualIntervention && manualIntervention.responded) {
      cleanupManualIntervention(manualIntervention.token);
      console.log(
        `Manual override reply already sent for ${senderIdString}. Skipping automated response.`,
      );
      return;
    }

    if (manualIntervention) {
      cleanupManualIntervention(manualIntervention.token);
      await notifyManualInterventionExpired(manualIntervention, client, replyText);
      console.log(
        `Manual override window expired for ${senderIdString}. Continuing with automated reply.`,
      );
    }
  }

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
    const sendOptions: any = { message: replyText };
    if (isGroupContext) {
      sendOptions.replyTo = (message as any).id;
    }
    await client.sendMessage(inputPeer || message.peerId, sendOptions);

    if (!outboundRecorded) {
      recordOutbound(senderIdString, Date.now() - composeStartedAt);
      outboundRecorded = true;
    }
    console.log(`Replied to ${senderIdString} using ${personaLabel}: "${replyText}"`);

    // Update last interaction time after successful response
    updateLastInteraction(senderIdString, chatId);
  } catch (error) {
    console.error("Failed to send message:", error);

    // Fallback: try using the API directly
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
      console.log(`Replied via API to ${senderIdString} using ${personaLabel}: "${replyText}"`);

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

async function safeAnswer(event: CallbackQueryEvent, message: string): Promise<void> {
  try {
    await event.answer({ message, cacheTime: 0 });
  } catch { }
}

export async function manualResponseCallbackHandler(event: CallbackQueryEvent): Promise<void> {
  const dataBuf = event.data;
  const client = (event as any)?._client;
  if (!dataBuf || !client) {
    return;
  }

  const payload = dataBuf.toString();
  if (!payload.startsWith("manual|")) {
    return;
  }

  const parts = payload.split("|");
  if (parts.length !== 3) {
    await safeAnswer(event, "Invalid selection.");
    return;
  }

  const token = parts[1];
  const optionIndex = Number(parts[2]);
  if (!Number.isFinite(optionIndex)) {
    await safeAnswer(event, "Unknown option.");
    return;
  }

  const intervention = manualInterventions.get(token);
  if (!intervention) {
    await safeAnswer(event, "This prompt has expired.");
    return;
  }

  const responderId = toIdStringSafe((event.query as any)?.userId ?? (event.sender as any)?.id);
  if (
    intervention.manualResponderId &&
    responderId &&
    intervention.manualResponderId !== responderId
  ) {
    await safeAnswer(event, "Not authorized for this prompt.");
    return;
  }

  if (intervention.responded) {
    await safeAnswer(event, "Reply already sent.");
    return;
  }

  const option = intervention.options[optionIndex];
  if (!option) {
    await safeAnswer(event, "Unknown option.");
    return;
  }

  intervention.responded = true;
  intervention.responseText = option.text;
  intervention.respondedAt = Date.now();

  try {
    const sendOptions: any = { message: option.text };
    if (intervention.isGroup && intervention.originalMessageId) {
      sendOptions.replyTo = intervention.originalMessageId;
    }
    await client.sendMessage(intervention.originalPeer, sendOptions);
    recordOutbound(intervention.originalSenderId, Date.now() - intervention.composeStartedAt);
    updateLastInteraction(intervention.originalSenderId, intervention.chatId);
    console.log(
      `Manual override option ${optionIndex + 1} sent to ${intervention.originalSenderId}.`,
    );
  } catch (error) {
    console.error("Failed to forward manual override reply:", error);
    intervention.responded = false;
    intervention.responseText = undefined;
    intervention.respondedAt = undefined;
    await safeAnswer(event, "Failed to send reply.");
    return;
  }

  await safeAnswer(event, "Reply sent!");

  try {
    const sourceMessage = await event.getMessage().catch(() => null);
    if (sourceMessage && typeof sourceMessage.message === "string") {
      const note = `\n\n✅ Sent option ${optionIndex + 1} to ${intervention.originalSenderId}.`;
      const updatedText = sourceMessage.message.includes(note.trim())
        ? sourceMessage.message
        : `${sourceMessage.message}${note}`;
      await event
        .edit({ message: event.messageId, text: updatedText, buttons: [] })
        .catch(() => { });
    }
  } catch (error) {
    console.warn("Failed to edit manual escalation message:", (error as any)?.message || error);
  }

  try {
    await client.sendMessage(intervention.manualPeer, {
      message: `✅ Forwarded option ${optionIndex + 1} to ${intervention.originalSenderId}.`,
    });
  } catch (error) {
    console.warn("Failed to send escalation confirmation:", (error as any)?.message || error);
  }
}
