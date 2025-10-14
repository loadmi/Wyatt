// src/telegram/client.ts
import "dotenv/config";
import { Api, TelegramClient } from "telegram";
import { LogLevel } from "telegram/extensions/Logger";
import { StringSession } from "telegram/sessions";
import { NewMessage } from "telegram/events";
// @ts-ignore - input module doesn't have types
import input from "input";
import { messageHandler } from "./handlers";
import { botStarted, botStopped } from "../metrics";
import bigInt from "big-integer";
import { generateGroupSentimentMessage } from "../llm/llm";

// Validate environment variables
if (!process.env.API_ID || !process.env.API_HASH) {
  throw new Error("API_ID and API_HASH must be defined in .env file");
}

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;

let client: TelegramClient;
let isRunning = false;
let isStopping = false;
let messageEvent: NewMessage | undefined;

type GroupCacheEntry = {
  entity: any;
  input?: any;
  title: string;
  type: string;
};

export type GroupSummary = {
  id: string;
  title: string;
  type: string;
};

type GroupSentimentResult = ControlResponse & { preview?: string };

const groupEntityCache = new Map<string, GroupCacheEntry>();

// Define a consistent return type for control functions
interface ControlResponse {
  success: boolean;
  message: string;
}

async function setupClient(): Promise<void> {
  const sessionString = process.env.SESSION_STRING || "";
  const stringSession = new StringSession(sessionString);
  client = new TelegramClient(stringSession, apiId, apiHash, {
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

  console.log("Connecting to Telegram...");
  
  // Check if we have a valid session string
  if (process.env.SESSION_STRING && process.env.SESSION_STRING.trim() !== '') {
    console.log("Using existing session string...");
    try {
      await client.connect();
      await client.getDialogs({ limit: 100 });
      console.log("✅ Connected using existing session!");
      return;
    } catch (error) {
      console.log("❌ Failed to connect with existing session, will need to re-authenticate...");
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
  if (process.env.SESSION_STRING !== session) {
    console.log("\n" + "=".repeat(60));
    console.log("🔑 IMPORTANT: Copy this session string to your .env file:");
    console.log("=".repeat(60));
    console.log(session);
    console.log("=".repeat(60));
    console.log("Update your .env file with this session string to avoid re-login next time.");
    console.log("=".repeat(60) + "\n");
  }
}

export async function startBot(): Promise<ControlResponse> {
  if (isRunning) {
    console.log("Bot is already running.");
    return { success: true, message: "Bot is already running." };
  }

  try {
    console.log("Starting Telegram bot...");
    
    // Always create a new client to ensure clean state
    if (client) {
      try {
        await client.destroy();
      } catch (e) {
        // Ignore teardown errors
      }
    }
    
    // Set up client with longer timeout (2 minutes for login process)
    const setupPromise = setupClient();
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Setup timeout after 2 minutes - please check your terminal for login prompts")), 120000);
    });
    
    await Promise.race([setupPromise, timeoutPromise]);
    
    messageEvent = new NewMessage({});
    client.addEventHandler(messageHandler, messageEvent);
    isRunning = true;
    groupEntityCache.clear();
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
    groupEntityCache.clear();
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

function ensureActiveClient(): TelegramClient {
  if (!client || !isRunning) {
    throw new Error("Bot is not running. Start the bot before using group controls.");
  }
  return client;
}

function toIdStringSafe(input: any): string | null {
  try {
    if (input === null || input === undefined) return null;
    if (typeof input === "string" || typeof input === "number" || typeof input === "bigint") {
      return String(input);
    }
    if (typeof input?.userId !== "undefined") return toIdStringSafe(input.userId);
    if (typeof input?.channelId !== "undefined") return toIdStringSafe(input.channelId);
    if (typeof input?.chatId !== "undefined") return toIdStringSafe(input.chatId);
    if (typeof input?.id !== "undefined") return toIdStringSafe(input.id);
    if (typeof input?.value !== "undefined") return toIdStringSafe(input.value);
    if (typeof input?.toString === "function") {
      const raw = input.toString();
      if (raw && raw !== "[object Object]") return String(raw);
    }
  } catch {
    return null;
  }
  return null;
}

function buildUserDisplayName(user: any): string {
  if (!user) return "Participant";
  const parts = [user.firstName, user.lastName].filter((x) => typeof x === "string" && x.trim().length > 0);
  if (parts.length > 0) {
    return parts.join(" ").trim();
  }
  if (typeof user.username === "string" && user.username.trim().length > 0) {
    return "@" + user.username.trim();
  }
  if (typeof user.title === "string" && user.title.trim().length > 0) {
    return user.title.trim();
  }
  if (user.id !== undefined) {
    return `member-${toIdStringSafe(user.id) ?? "unknown"}`;
  }
  return "Participant";
}

function sanitizeMessageText(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

function makeDialogKey(dialog: any): string | null {
  const preferred = dialog?.id ?? dialog?.peerId ?? dialog?.entity?.id;
  return toIdStringSafe(preferred);
}

export async function listGroups(): Promise<GroupSummary[]> {
  const activeClient = ensureActiveClient();
  const dialogs = await activeClient.getDialogs({ limit: 150 }).catch(() => [] as any[]);
  const results: GroupSummary[] = [];
  groupEntityCache.clear();

  for (const dialog of dialogs as any[]) {
    const entity = dialog?.entity;
    if (!entity) continue;
    const isGroupLike = Boolean(dialog?.isGroup || dialog?.isChannel || entity?.megagroup || entity?.gigagroup || entity?.broadcast || entity?.className === "Chat" || entity?.className === "Channel");
    if (!isGroupLike) continue;

    const key = makeDialogKey(dialog);
    if (!key) continue;

    const title = String(entity?.title || dialog?.name || "Unnamed group");
    const type = entity?.megagroup ? "supergroup" : entity?.broadcast ? "channel" : "group";

    results.push({ id: key, title, type });
    groupEntityCache.set(key, { entity, input: dialog?.inputEntity, title, type });
  }

  results.sort((a, b) => a.title.localeCompare(b.title));
  return results;
}

async function resolveGroupPeer(groupId: string): Promise<GroupCacheEntry> {
  if (!groupId) {
    throw new Error("Group id is required");
  }

  let cached = groupEntityCache.get(groupId);
  if (!cached) {
    await listGroups();
    cached = groupEntityCache.get(groupId);
  }
  if (!cached) {
    throw new Error("Unknown group identifier");
  }

  if (!cached.input) {
    try {
      const activeClient = ensureActiveClient();
      cached.input = await activeClient.getInputEntity(cached.entity);
      groupEntityCache.set(groupId, cached);
    } catch (e) {
      throw new Error("Failed to resolve group entity");
    }
  }

  return cached;
}

export async function sendGroupSentimentMessage(groupId: string): Promise<GroupSentimentResult> {
  try {
    const activeClient = ensureActiveClient();
    const entry = await resolveGroupPeer(groupId);

    const historyLimit = Number.isFinite(Number(process.env.GROUP_SENTIMENT_HISTORY_LIMIT))
      ? Number(process.env.GROUP_SENTIMENT_HISTORY_LIMIT)
      : 60;

    const history: any = await activeClient
      .invoke(
        new Api.messages.GetHistory({
          peer: entry.input,
          offsetId: 0,
          addOffset: 0,
          limit: historyLimit,
          maxId: 0,
          minId: 0,
          hash: bigInt.zero,
        })
      )
      .catch((error: any) => {
        console.error("Failed to fetch group history:", error);
        throw new Error("Unable to fetch group conversation");
      });

    const messages: any[] = Array.isArray(history?.messages) ? history.messages : [];
    const users: any[] = Array.isArray(history?.users) ? history.users : [];

    const userMap = new Map<string, string>();
    for (const user of users) {
      const id = toIdStringSafe(user?.id);
      if (id) {
        userMap.set(id, buildUserDisplayName(user));
      }
    }

    const maxChars = Number.isFinite(Number(process.env.GROUP_SENTIMENT_HISTORY_CHARS))
      ? Number(process.env.GROUP_SENTIMENT_HISTORY_CHARS)
      : 3800;

    const collected: { author: string; text: string }[] = [];
    let charBudget = 0;

    const eligible = messages
      .filter((m) => m instanceof Api.Message && typeof m.message === "string" && m.message.trim().length > 0)
      .sort((a, b) => (Number(a.date) || 0) - (Number(b.date) || 0));

    for (let i = eligible.length - 1; i >= 0; i -= 1) {
      const msg = eligible[i];
      const text = sanitizeMessageText(String(msg.message));
      if (!text) continue;
      let author = entry.title;
      const fromId = toIdStringSafe(msg.fromId || msg.peerId);
      if (fromId && userMap.has(fromId)) {
        author = userMap.get(fromId) as string;
      }
      const contribution = author.length + text.length + 5;
      if (collected.length > 0 && (charBudget + contribution > maxChars)) {
        break;
      }
      collected.push({ author, text });
      charBudget += contribution;
      if (collected.length >= historyLimit) {
        break;
      }
    }

    collected.reverse();

    const llmReply = await generateGroupSentimentMessage(collected);
    const reply = sanitizeMessageText(llmReply) || "Just dropping by to stay in the loop.";

    await activeClient.sendMessage(entry.input, { message: reply });

    const preview = reply.length > 160 ? `${reply.slice(0, 157)}…` : reply;

    return {
      success: true,
      message: `Sent sentiment-matching message to ${entry.title}.`,
      preview,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send sentiment message";
    return { success: false, message };
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
async function setupClientNonInteractive(): Promise<void> {
  const sessionString = process.env.SESSION_STRING || "";
  const stringSession = new StringSession(sessionString);
  client = new TelegramClient(stringSession, apiId, apiHash, {
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

  if (process.env.SESSION_STRING && process.env.SESSION_STRING.trim() !== "") {
    try {
      await client.connect();
      await client.getDialogs({ limit: 1 });
      return;
    } catch (e) {
      throw new Error(
        "Existing session is invalid or expired; interactive login required"
      );
    }
  }
  throw new Error("No session configured; interactive login required");
}

// Non-interactive start for auto-start on server boot.
// Only succeeds if an existing valid session is available; otherwise fails gracefully.
export async function startBotNonInteractive(): Promise<ControlResponse> {
  if (isRunning) {
    return { success: true, message: "Bot is already running." };
  }
  try {
    if (client) {
      try {
        await client.destroy();
      } catch {}
    }

    await setupClientNonInteractive();
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
