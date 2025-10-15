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
import { generateSentimentMessage, SentimentSample } from "../llm/llm";
import { getActiveTelegramAccount, updateTelegramAccount } from "../config";
import type { TelegramAccount } from "../config";

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

async function resolveGroupInputPeer(groupId: string): Promise<GroupCacheEntry | undefined> {
  if (groupCache.has(groupId)) {
    return groupCache.get(groupId);
  }
  const groups = await listTelegramGroups();
  return groups.find((g) => g.id === groupId) ? groupCache.get(groupId) : undefined;
}

export async function listTelegramGroups(): Promise<TelegramGroup[]> {
  ensureClientReady();

  const dialogs = await client.getDialogs({ limit: 200 });
  const nextCache = new Map<string, GroupCacheEntry>();
  const groups: TelegramGroup[] = [];

  for (const dialog of dialogs) {
    const isGroupLike = (dialog as any)?.isGroup === true || (dialog as any)?.isChannel === true;
    if (!isGroupLike) continue;

    const entity: any = (dialog as any).entity;
    const key = toDialogKey((dialog as any).id ?? entity?.id ?? entity?.channelId ?? entity?.chatId);
    if (!key) continue;

    const title =
      (entity?.title && String(entity.title)) ||
      (entity?.firstName && String(entity.firstName)) ||
      (entity?.username && String(entity.username)) ||
      `Group ${key}`;

    let inputPeer: any;
    try {
      inputPeer = await client.getInputEntity(entity);
    } catch (error) {
      console.warn(`Failed to resolve input entity for group ${title}:`, (error as any)?.message || error);
      continue;
    }

    nextCache.set(key, { title, inputPeer });
    groups.push({ id: key, title });
  }

  groups.sort((a, b) => a.title.localeCompare(b.title));
  groupCache.clear();
  for (const [key, value] of nextCache.entries()) {
    groupCache.set(key, value);
  }

  return groups;
}

async function collectGroupSamples(inputPeer: any): Promise<SentimentSample[]> {
  const MAX_MESSAGES = 60;
  const MAX_CHARACTERS = 6000;
  const samples: SentimentSample[] = [];
  let charCount = 0;

  try {
    const iterator = client.iterMessages(inputPeer, { limit: MAX_MESSAGES });
    for await (const message of iterator) {
      if (!message) continue;
      const text = typeof message.message === "string" ? message.message.trim() : "";
      if (!text) continue;

      const senderName = (() => {
        try {
          const sender: any = (message as any).sender;
          if (sender?.title) return String(sender.title);
          if (sender?.firstName || sender?.lastName) {
            return [sender.firstName, sender.lastName].filter(Boolean).join(" ").trim() || "Participant";
          }
          if (sender?.username) return String(sender.username);
        } catch { }
        const senderId = (message as any)?.senderId;
        if (typeof senderId === "bigint" || typeof senderId === "number" || typeof senderId === "string") {
          return `User ${senderId}`;
        }
        return "Participant";
      })();

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

      samples.push({ speaker: senderName, text, timestamp });
      charCount += text.length;
      if (charCount >= MAX_CHARACTERS) break;
    }
  } catch (error) {
    console.warn("Failed to iterate group messages:", (error as any)?.message || error);
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

  const samples = await collectGroupSamples(entry.inputPeer);
  if (samples.length === 0) {
    return { success: false, message: "No recent text messages found to analyse." };
  }

  let crafted = "";
  try {
    crafted = await generateSentimentMessage(samples);
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
