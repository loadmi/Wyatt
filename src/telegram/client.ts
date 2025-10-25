// src/telegram/client.ts
import "dotenv/config";
import { TelegramClient } from "telegram";
import { LogLevel } from "telegram/extensions/Logger";
import { StringSession } from "telegram/sessions";
import { NewMessage } from "telegram/events";
// @ts-ignore - input module doesn't have types
import input from "input";
import { messageHandler } from "./handlers";
import { botStarted, botStopped } from "../metrics";
import { generateBlendMessage, SentimentSample } from "../llm/llm";
import { getActiveTelegramAccount, updateTelegramAccount, getTelegramAccounts } from "../config";
import type { TelegramAccount } from "../config";
import { getChatPersonaSummary } from "./chatPersonality";

let client: TelegramClient;
let isRunning = false;
let isStopping = false;
let messageEvent: NewMessage | undefined;

type GroupCacheEntry = {
  title: string;
  inputPeer: any;
};

export type TelegramGroup = {
  id: string;
  title: string;
};

const groupCache = new Map<string, GroupCacheEntry>();

type ChatCacheEntry = {
  title: string;
  type: "private" | "group" | "channel";
  inputPeer: any;
};

export type DashboardChatSummary = {
  id: string;
  title: string;
  type: ChatCacheEntry["type"];
  lastMessage?: string;
  lastTimestamp?: number;
  unreadCount?: number;
  personaId?: string;
  personaLabel?: string;
  usesDefaultPersona?: boolean;
  personaUpdatedAt?: number;
};

export type DashboardChatMessage = {
  id: number;
  text: string;
  from: "bot" | "contact";
  sender?: string;
  timestamp?: number;
};

export type DashboardChatHistory = {
  chat: {
    id: string;
    title: string;
    type: ChatCacheEntry["type"];
    personaId?: string;
    personaLabel?: string;
    usesDefaultPersona?: boolean;
    personaUpdatedAt?: number;
    lastTimestamp?: number;
  };
  messages: DashboardChatMessage[];
};

const chatCache = new Map<string, ChatCacheEntry>();

// Define a consistent return type for control functions
interface ControlResponse {
  success: boolean;
  message: string;
}

function requireActiveAccount(): TelegramAccount {
  const account = getActiveTelegramAccount();
  if (!account) {
    throw new Error("No active Telegram account configured. Add one under Configuration → Telegram Accounts.");
  }

  if (!Number.isFinite(account.apiId)) {
    throw new Error(`Active account "${account.label}" is missing a valid API ID.`);
  }

  const apiHash = account.apiHash?.trim();
  if (!apiHash) {
    throw new Error(`Active account "${account.label}" is missing an API hash.`);
  }

  const sessionString = (account.sessionString ?? "").trim();

  return {
    ...account,
    apiId: Math.trunc(account.apiId),
    apiHash,
    sessionString,
  };
}

async function persistSession(account: TelegramAccount, session: string): Promise<void> {
  const trimmed = session.trim();
  if (!trimmed || trimmed === account.sessionString) {
    return;
  }
  try {
    updateTelegramAccount(account.id, { sessionString: trimmed });
    console.log(`Stored new session for account "${account.label}".`);
  } catch (error) {
    console.warn(
      `Failed to persist session for account "${account.label}":`,
      (error as any)?.message || error,
    );
  }
}

async function setupClient(account: TelegramAccount): Promise<void> {
  const stringSession = new StringSession(account.sessionString || "");
  client = new TelegramClient(stringSession, account.apiId, account.apiHash, {
    connectionRetries: 10,       // more chances to reconnect
    requestRetries: 5,           // retry failed API calls
    retryDelay: 1000,            // 1s backoff
    timeout: 20000,              // 20s request timeout
    useWSS: true,                // WebSocket over TLS (often more reliable)
  });

  // Quietly ignore transient errors during shutdown
  client.onError = async (err: Error) => {
    if (isStopping) {
      return;
    }
  };

  console.log(`Connecting to Telegram as "${account.label}"...`);

  // Check if we have a valid session string
  if (account.sessionString && account.sessionString.trim() !== "") {
    console.log("Using stored session string...");
    try {
      await client.connect();
      await client.getDialogs({ limit: 100 });
      console.log("✅ Connected using existing session!");
      return;
    } catch (error) {
      console.log("❌ Stored session was rejected, starting interactive login...");
    }
  }

  console.log("🔐 No valid session found. Starting authentication process...");
  console.log("⚠️  IMPORTANT: You need to complete the login in your terminal/console window!");
  console.log("⚠️  The web interface will show 'Starting bot...' until login is complete.");
  console.log("⏰ You have 2 minutes to complete the login process.");
  
  console.log("🔄 Calling client.start()...");
  await client.start({
    phoneNumber: async () => {
      console.log("\n📱 Please enter your phone number (with country code, e.g., +1234567890):");
      const phone = await input.text("Phone number: ");
      console.log("📱 Phone number received, sending to Telegram...");
      return phone;
    },
    password: async () => {
      console.log("\n🔐 Please enter your 2FA password (if you have one, press Enter to skip):");
      const password = await input.text("Password: ");
      console.log("🔐 Password received, sending to Telegram...");
      return password;
    },
    phoneCode: async () => {
      console.log("\n📨 Please enter the verification code sent to your phone:");
      const code = await input.text("Verification code: ");
      console.log("📨 Verification code received, sending to Telegram...");
      return code;
    },
    onError: (err) => {
      console.error("❌ Telegram connection error:", err);
      throw err;
    },
  });
  console.log("✅ client.start() completed successfully!");

  console.log("✅ Telegram client connected successfully!");

  const session = client.session.save();
  if (typeof session === 'string') {
    await persistSession(account, session);
    console.log("🔐 Session saved to dashboard configuration.");
  } else {
    console.warn("Received unexpected session data; skipping persistence.");
  }
}

// Track in-progress logins to avoid duplicate prompts per account
const loginInProgress = new Set<string>();

function findAccountById(id: string): TelegramAccount | undefined {
  const all = getTelegramAccounts();
  return all.find((a) => a.id === id);
}

// Background interactive login for a specific account using a dedicated client instance.
// Does not change the running bot state; persists session on success.
async function loginOnly(account: TelegramAccount): Promise<void> {
  // Force a clean interactive login regardless of any stored session
  const stringSession = new StringSession("");
  const temp = new TelegramClient(stringSession, account.apiId, account.apiHash, {
    connectionRetries: 10,
    requestRetries: 5,
    retryDelay: 1000,
    timeout: 20000,
    useWSS: true,
  });

  console.log(`Starting interactive login in console for account "${account.label}"...`);
  console.log("Follow the prompts below to complete Telegram login.");

  try {
    await temp.start({
      phoneNumber: async () => {
        console.log("\nPlease enter your phone number (with country code, e.g., +1234567890):");
        const phone = await input.text("Phone number: ");
        return phone;
      },
      password: async () => {
        console.log("\nPlease enter your 2FA password (if you have one, press Enter to skip):");
        const password = await input.text("Password: ");
        return password;
      },
      phoneCode: async () => {
        console.log("\nPlease enter the verification code sent to your phone:");
        const code = await input.text("Verification code: ");
        return code;
      },
      onError: (err) => {
        console.error("Telegram connection error during login:", err);
        throw err;
      },
    });

    const session = temp.session.save();
    if (typeof session === "string") {
      await persistSession(account, session);
    }
  } finally {
    try { await temp.disconnect(); } catch {}
    try { await temp.destroy(); } catch {}
  }
}

export async function initiateAccountConsoleLogin(accountId: string): Promise<ControlResponse> {
  const id = (accountId || "").trim();
  if (!id) return { success: false, message: "Account ID is required." };

  const account = findAccountById(id);
  if (!account) return { success: false, message: "Account not found." };

  if (!Number.isFinite(account.apiId) || !account.apiHash?.trim()) {
    return { success: false, message: "Account is missing API credentials." };
  }

  if (loginInProgress.has(id)) {
    return { success: false, message: "Login already in progress for this account." };
  }

  loginInProgress.add(id);
  (async () => {
    try {
      await loginOnly({ ...account, apiId: Math.trunc(account.apiId), apiHash: account.apiHash.trim(), sessionString: (account.sessionString || "").trim() });
      console.log(`Interactive login finished for account "${account.label}".`);
    } catch (e) {
      console.error(`Interactive login failed for account "${account.label}":`, (e as any)?.message || e);
    } finally {
      loginInProgress.delete(id);
    }
  })();

  return { success: true, message: `Interactive login started for "${account.label}". Check the server console.` };
}

export async function startBot(): Promise<ControlResponse> {
  if (isRunning) {
    console.log("Bot is already running.");
    return { success: true, message: "Bot is already running." };
  }

  try {
    const account = requireActiveAccount();
    console.log(`Starting Telegram bot for account "${account.label}"...`);

    // Always create a new client to ensure clean state
    if (client) {
      try {
        await client.destroy();
      } catch (e) {
        // Ignore teardown errors
      }
    }

    // Set up client with longer timeout (2 minutes for login process)
    const setupPromise = setupClient(account);
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Setup timeout after 2 minutes - please check your terminal for login prompts")), 120000);
    });

    await Promise.race([setupPromise, timeoutPromise]);
    
    messageEvent = new NewMessage({});
    client.addEventHandler(messageHandler, messageEvent);
    isRunning = true;
    botStarted();
    console.log("Bot started and is listening for messages.");
    return { success: true, message: "Bot started successfully." };
  } catch (error) {
    console.error("Failed to start bot:", error);
    isRunning = false;
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Failed to start bot: ${errorMessage}` };
  }
}

export async function stopBot(): Promise<ControlResponse> {
  if (!isRunning) {
    console.log("Bot is not running.");
    return { success: true, message: "Bot is already stopped." };
  }
  try {
    console.log("Stopping Telegram bot...");
    await teardownClient();
    isRunning = false;
    client = null as any; // Reset client reference
    botStopped();
    console.log("✅ Bot stopped successfully.");
    return { success: true, message: "Bot stopped successfully." };
  } catch (error) {
    console.error("Failed to stop bot:", error);
    isRunning = false;
    client = null as any; // Reset client reference even on error
    return { success: false, message: "Failed to stop bot." };
  }
}

export function getStatus(): { isRunning: boolean } {
  return { isRunning };
}

function ensureClientReady(): void {
  if (!client || !isRunning) {
    throw new Error("Telegram client is not running");
  }
}

function toDialogKey(raw: any): string | null {
  try {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === "string") return raw;
    if (typeof raw === "number" || typeof raw === "bigint") return String(raw);
    if (raw?.value !== undefined) return toDialogKey(raw.value);
    if (raw?.id !== undefined) return toDialogKey(raw.id);
    if (typeof raw.toString === "function") {
      const str = raw.toString();
      return str && str !== "[object Object]" ? str : null;
    }
  } catch { }
  return null;
}

function resolveDialogType(dialog: any, entity: any): ChatCacheEntry["type"] {
  if (dialog?.isUser) return "private";
  if (dialog?.isGroup) return "group";
  if (dialog?.isChannel) {
    if (entity?.megagroup || entity?.gigagroup || entity?.isGroup) {
      return "group";
    }
    return "channel";
  }

  const className = entity?.className || entity?.constructor?.name;
  if (className === "User") return "private";
  if (className === "Chat" || className === "ChatForbidden") return "group";
  if (className === "Channel" || className === "ChannelForbidden") {
    return entity?.megagroup ? "group" : "channel";
  }
  return "group";
}

function resolveDialogTitle(dialog: any, entity: any, fallbackId: string): string {
  const titleSources = [
    dialog?.title,
    entity?.title,
    entity?.name,
    entity?.firstName,
    entity?.username,
  ]
    .map((value) => (typeof value === "string" ? value : null))
    .filter((value) => value && value.trim().length > 0) as string[];

  if (titleSources.length > 0) {
    if (entity?.lastName && typeof entity.lastName === "string") {
      const combined = `${titleSources[0]} ${entity.lastName}`.trim();
      if (combined.length > 0) {
        return combined;
      }
    }
    return titleSources[0];
  }

  if (entity?.lastName && typeof entity.lastName === "string") {
    const firstName = typeof entity?.firstName === "string" ? entity.firstName : "";
    const composed = `${firstName} ${entity.lastName}`.trim();
    if (composed.length > 0) {
      return composed;
    }
  }

  return `Chat ${fallbackId}`;
}

function normaliseTimestamp(value: any): number | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") {
    if (value > 1_000_000_000_000) return value;
    return value * 1000;
  }
  try {
    const numeric = Number(value.valueOf?.() ?? value);
    if (Number.isFinite(numeric)) {
      if (numeric > 1_000_000_000_000) return numeric;
      return numeric * 1000;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function describeSender(message: any, fallback: string): string {
  try {
    const sender: any = message?.sender;
    const parts: string[] = [];
    if (typeof sender?.firstName === "string") parts.push(sender.firstName);
    if (typeof sender?.lastName === "string") parts.push(sender.lastName);
    const composed = parts.join(" ").trim();
    if (composed) return composed;
    if (typeof sender?.title === "string" && sender.title.trim()) return sender.title.trim();
    if (typeof sender?.username === "string" && sender.username.trim()) return sender.username.trim();
    const senderId = sender?.id ?? sender?.userId ?? sender?.channelId ?? sender?.chatId;
    if (senderId !== undefined && senderId !== null) {
      return `User ${senderId}`;
    }
  } catch { }
  return fallback;
}

async function resolveChatEntry(chatId: string): Promise<ChatCacheEntry | undefined> {
  if (chatCache.has(chatId)) {
    return chatCache.get(chatId);
  }
  try {
    await listChats();
  } catch {
    return undefined;
  }
  return chatCache.get(chatId);
}

async function resolveGroupInputPeer(groupId: string): Promise<GroupCacheEntry | undefined> {
  if (groupCache.has(groupId)) {
    return groupCache.get(groupId);
  }
  const entry = await resolveChatEntry(groupId);
  if (entry && entry.type !== "private") {
    const groupEntry: GroupCacheEntry = { title: entry.title, inputPeer: entry.inputPeer };
    groupCache.set(groupId, groupEntry);
    return groupEntry;
  }
  const groups = await listTelegramGroups();
  return groups.find((g) => g.id === groupId) ? groupCache.get(groupId) : undefined;
}

export async function listTelegramGroups(): Promise<TelegramGroup[]> {
  ensureClientReady();

  if (chatCache.size === 0) {
    await listChats();
  }

  const groups: TelegramGroup[] = [];
  groupCache.clear();

  for (const [id, entry] of chatCache.entries()) {
    if (entry.type === "private") {
      continue;
    }
    groupCache.set(id, { title: entry.title, inputPeer: entry.inputPeer });
    groups.push({ id, title: entry.title });
  }

  groups.sort((a, b) => a.title.localeCompare(b.title));
  return groups;
}

export async function listChats(): Promise<DashboardChatSummary[]> {
  ensureClientReady();

  const dialogs = await client.getDialogs({ limit: 300 });
  const nextCache = new Map<string, ChatCacheEntry>();
  const summaries: DashboardChatSummary[] = [];

  for (const dialog of dialogs) {
    const entity: any = (dialog as any)?.entity;
    if (!entity) continue;

    const key = toDialogKey((dialog as any).id ?? entity?.id ?? entity?.userId ?? entity?.channelId ?? entity?.chatId);
    if (!key) continue;

    let inputPeer: any;
    try {
      inputPeer = await client.getInputEntity(entity);
    } catch (error) {
      console.warn(
        `Failed to resolve input entity for dialog ${String(entity?.username || entity?.title || key)}:`,
        (error as any)?.message || error,
      );
      continue;
    }

    const type = resolveDialogType(dialog, entity);
    const title = resolveDialogTitle(dialog, entity, key);
    const message: any = (dialog as any)?.message;
    const lastMessage = typeof message?.message === "string" ? message.message.trim() : "";
    const lastTimestamp = normaliseTimestamp(message?.date);
    const unreadCountRaw = Number((dialog as any)?.unreadCount ?? 0);
    const unreadMentionsRaw = Number((dialog as any)?.unreadMentionsCount ?? 0);
    const unreadTotal = [unreadCountRaw, unreadMentionsRaw]
      .map((n) => (Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0))
      .reduce((acc, value) => acc + value, 0);

    nextCache.set(key, { title, type, inputPeer });

    const summary: DashboardChatSummary = { id: key, title, type };
    if (lastMessage) {
      summary.lastMessage = lastMessage.length > 220 ? `${lastMessage.slice(0, 217)}…` : lastMessage;
    }
    if (Number.isFinite(lastTimestamp)) {
      summary.lastTimestamp = lastTimestamp;
    }
    if (unreadTotal > 0) {
      summary.unreadCount = unreadTotal;
    }
    try {
      const persona = await getChatPersonaSummary(key);
      summary.personaId = persona.personaId;
      summary.personaLabel = persona.personaLabel;
      summary.usesDefaultPersona = persona.usesDefaultPersona;
      summary.personaUpdatedAt = persona.updatedAt;
    } catch (error) {
      console.warn(
        `Failed to resolve chat persona for ${title || key}:`,
        (error as any)?.message || error,
      );
    }
    summaries.push(summary);
  }

  chatCache.clear();
  for (const [id, entry] of nextCache.entries()) {
    chatCache.set(id, entry);
  }

  summaries.sort((a, b) => {
    const timeA = a.lastTimestamp ?? 0;
    const timeB = b.lastTimestamp ?? 0;
    if (timeA === timeB) {
      return a.title.localeCompare(b.title);
    }
    return timeB - timeA;
  });

  return summaries;
}

export async function getChatHistory(chatId: string, limit = 150): Promise<DashboardChatHistory> {
  ensureClientReady();

  const entry = await resolveChatEntry(chatId);
  if (!entry) {
    throw new Error("Chat not found or not accessible.");
  }

  const messages: DashboardChatMessage[] = [];
  try {
    const iterator = client.iterMessages(entry.inputPeer, { limit });
    for await (const message of iterator) {
      if (!message) continue;
      const idRaw = (message as any)?.id;
      const id = typeof idRaw === "number" ? idRaw : Number(idRaw) || Date.now();
      let text = typeof (message as any)?.message === "string" ? String((message as any).message).trim() : "";
      if (!text) {
        if ((message as any)?.media) {
          text = "[media message]";
        } else if ((message as any)?.action) {
          text = "[system message]";
        } else {
          text = "[non-text message]";
        }
      }

      const timestamp = normaliseTimestamp((message as any)?.date);
      const from = (message as any)?.out ? "bot" : "contact";
      const senderName = from === "bot" ? "You" : describeSender(message, entry.title);

      messages.push({ id, text, from, sender: senderName, timestamp });
    }
  } catch (error) {
    console.warn(`Failed to fetch chat history for ${chatId}:`, (error as any)?.message || error);
  }

  messages.sort((a, b) => {
    const timeA = a.timestamp ?? 0;
    const timeB = b.timestamp ?? 0;
    if (timeA === timeB) {
      return a.id - b.id;
    }
    return timeA - timeB;
  });

  let personaId: string | undefined;
  let personaLabel: string | undefined;
  let usesDefault: boolean | undefined;
  let personaUpdatedAt: number | undefined;
  try {
    const persona = await getChatPersonaSummary(chatId);
    personaId = persona.personaId;
    personaLabel = persona.personaLabel;
    usesDefault = persona.usesDefaultPersona;
    personaUpdatedAt = persona.updatedAt;
  } catch (error) {
    console.warn(`Failed to resolve chat persona for history ${chatId}:`, (error as any)?.message || error);
  }

  const lastTimestamp = messages.length > 0 ? messages[messages.length - 1].timestamp : undefined;

  return {
    chat: {
      id: chatId,
      title: entry.title,
      type: entry.type,
      personaId,
      personaLabel,
      usesDefaultPersona: usesDefault,
      personaUpdatedAt,
      lastTimestamp,
    },
    messages,
  };
}

export async function sendMessageToChat(chatId: string, text: string): Promise<{ success: boolean; message: string }> {
  try {
    ensureClientReady();
  } catch (error) {
    const msg = (error as any)?.message || "Telegram client is not running";
    return { success: false, message: msg };
  }

  const entry = await resolveChatEntry(chatId);
  if (!entry) {
    return { success: false, message: "Chat not found or not accessible." };
  }

  const payload = typeof text === "string" ? text.trim() : String(text ?? "").trim();
  if (!payload) {
    return { success: false, message: "Message text is required." };
  }

  try {
    await client.sendMessage(entry.inputPeer, { message: payload });
    return { success: true, message: "Message sent." };
  } catch (error) {
    console.error(`Failed to send manual message to chat ${chatId}:`, error);
    return { success: false, message: "Failed to send message." };
  }
}

export async function sendBlendMessage(chatId: string): Promise<{ success: boolean; message: string; preview?: string }> {
  try {
    ensureClientReady();
  } catch (error) {
    const msg = (error as any)?.message || "Telegram client is not running";
    return { success: false, message: msg };
  }

  const entry = await resolveChatEntry(chatId);
  if (!entry) {
    return { success: false, message: "Chat not found or not accessible." };
  }

  const samples = await collectBlendSamples({
    inputPeer: entry.inputPeer,
    title: entry.title,
    type: entry.type,
  });
  if (samples.length === 0) {
    return { success: false, message: "No recent text messages found to analyse." };
  }

  const mode = entry.type === "private" ? "private" : "group";
  let crafted = "";
  try {
    crafted = await generateBlendMessage(samples, {
      mode,
      partnerName: mode === "private" ? entry.title : undefined,
    });
  } catch (error) {
    console.warn("Failed to generate blend message:", (error as any)?.message || error);
    return { success: false, message: "LLM request failed." };
  }

  try {
    await client.sendMessage(entry.inputPeer, { message: crafted });
    return { success: true, message: `Sent blend message to ${entry.title}.`, preview: crafted };
  } catch (error) {
    console.error(`Failed to send blend message to chat ${chatId}:`, error);
    return { success: false, message: "Failed to send message." };
  }
}

type BlendSampleSource = {
  inputPeer: any;
  title: string;
  type?: ChatCacheEntry["type"];
};

async function collectBlendSamples(source: BlendSampleSource): Promise<SentimentSample[]> {
  const MAX_MESSAGES = 60;
  const MAX_CHARACTERS = 6000;
  const samples: SentimentSample[] = [];
  let charCount = 0;

  try {
    const iterator = client.iterMessages(source.inputPeer, { limit: MAX_MESSAGES });
    for await (const message of iterator) {
      if (!message) continue;
      const text = typeof (message as any)?.message === "string" ? String((message as any).message).trim() : "";
      if (!text) continue;

      const timestamp = (() => {
        const date: any = (message as any).date;
        if (date instanceof Date) return date.getTime();
        if (typeof date === "number") return date * 1000;
        if (date && typeof date.valueOf === "function") {
          const v = Number(date.valueOf());
          if (Number.isFinite(v)) return v;
        }
        return undefined;
      })();

      const speaker = (() => {
        const isOutgoing = Boolean((message as any)?.out);
        if (source.type === "private") {
          if (isOutgoing) return "You";
          const name = (source.title || "").trim();
          return name || "Contact";
        }
        if (isOutgoing) {
          return "You";
        }
        return describeSender(message, "Participant");
      })();

      samples.push({ speaker, text, timestamp });
      charCount += text.length;
      if (charCount >= MAX_CHARACTERS) break;
    }
  } catch (error) {
    console.warn(
      `Failed to iterate messages for blend in ${source.title || "chat"}:`,
      (error as any)?.message || error,
    );
  }

  samples.reverse();
  if (samples.length > MAX_MESSAGES) {
    return samples.slice(samples.length - MAX_MESSAGES);
  }
  return samples;
}

export async function sendSentimentToGroup(groupId: string): Promise<{ success: boolean; message: string; preview?: string }> {
  try {
    ensureClientReady();
  } catch (error) {
    const msg = (error as any)?.message || "Telegram client is not running";
    return { success: false, message: msg };
  }

  const entry = await resolveGroupInputPeer(groupId);
  if (!entry) {
    return { success: false, message: "Group not found or not accessible." };
  }

  const samples = await collectBlendSamples({ inputPeer: entry.inputPeer, title: entry.title, type: "group" });
  if (samples.length === 0) {
    return { success: false, message: "No recent text messages found to analyse." };
  }

  let crafted = "";
  try {
    crafted = await generateBlendMessage(samples, { mode: "group" });
  } catch (error) {
    console.warn("Failed to generate sentiment message:", (error as any)?.message || error);
    return { success: false, message: "LLM request failed." };
  }

  try {
    await client.sendMessage(entry.inputPeer, { message: crafted });
    return { success: true, message: `Sent message to ${entry.title}.`, preview: crafted };
  } catch (error) {
    console.error("Failed to send sentiment message:", error);
    return { success: false, message: "Failed to send message to group." };
  }
}

// Graceful teardown of the Telegram client and handlers
async function teardownClient(): Promise<void> {
  isStopping = true;
  try {
    if (client) {
      try { client.setLogLevel(LogLevel.NONE); } catch {}
      try {
        if (messageEvent) {
          client.removeEventHandler(messageHandler, messageEvent);
        }
      } catch {}
      try { await client.destroy(); } catch {}
    }
  } finally {
    isStopping = false;
  }
}

// Helper: minimal setup that only uses an existing session and never prompts.
async function setupClientNonInteractive(account: TelegramAccount): Promise<void> {
  const sessionString = (account.sessionString || "").trim();
  if (!sessionString) {
    throw new Error("No session configured for the active account");
  }
  const stringSession = new StringSession(sessionString);
  client = new TelegramClient(stringSession, account.apiId, account.apiHash, {
    connectionRetries: 10,
    requestRetries: 5,
    retryDelay: 1000,
    timeout: 20000,
    useWSS: true,
  });

  // Quietly ignore transient errors during shutdown
  client.onError = async (err: Error) => {
    if (isStopping) return;
  };

  try {
    await client.connect();
    await client.getDialogs({ limit: 1 });
  } catch (e) {
    throw new Error(
      "Existing session is invalid or expired; interactive login required",
    );
  }
}

// Non-interactive start for auto-start on server boot.
// Only succeeds if an existing valid session is available; otherwise fails gracefully.
export async function startBotNonInteractive(): Promise<ControlResponse> {
  if (isRunning) {
    return { success: true, message: "Bot is already running." };
  }
  try {
    const account = requireActiveAccount();
    if (!account.sessionString) {
      return {
        success: false,
        message: `Active account "${account.label}" does not have a stored session string.`,
      };
    }
    if (client) {
      try {
        await client.destroy();
      } catch {}
    }

    await setupClientNonInteractive(account);
    messageEvent = new NewMessage({});
    client.addEventHandler(messageHandler, messageEvent);
    isRunning = true;
    botStarted();
    return { success: true, message: "Bot started using existing session." };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Auto-start skipped: ${errorMessage}`,
    };
  }
}
