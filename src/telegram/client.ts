// src/telegram/client.ts
import "dotenv/config";
import { TelegramClient, Api } from "telegram";
import { LogLevel } from "telegram/extensions/Logger";
import { StringSession } from "telegram/sessions";
import { NewMessage } from "telegram/events";
// @ts-ignore - input module doesn't have types
import input from "input";
import { messageHandler } from "./handlers";
import { botStarted, botStopped, recordOutbound } from "../metrics";
import bigInt from "big-integer";
import { craftSentimentBlendMessage, SentimentSample } from "../llm/llm";

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

// Define a consistent return type for control functions
interface ControlResponse {
  success: boolean;
  message: string;
}

export interface GroupChatInfo {
  id: string;
  title: string;
}

export interface SentimentBroadcastResponse extends ControlResponse {
  groupId?: string;
  groupTitle?: string;
  generated?: string;
}

const groupDirectory = new Map<string, { title: string; peer: any }>();

function toIdString(value: any): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value?.userId !== "undefined") return toIdString(value.userId);
  if (typeof value?.channelId !== "undefined") return `channel:${toIdString(value.channelId)}`;
  if (typeof value?.chatId !== "undefined") return toIdString(value.chatId);
  if (typeof value?.id !== "undefined") return toIdString(value.id);
  if (typeof value?.value !== "undefined") return toIdString(value.value);
  if (typeof value?.toString === "function") {
    const rendered = value.toString();
    if (rendered && rendered !== "[object Object]") {
      return String(rendered);
    }
  }
  return null;
}

function deriveDisplayTitle(entity: any): string {
  if (!entity) return "Unnamed group";
  const nameParts: string[] = [];
  if (typeof entity.title === "string" && entity.title.trim().length > 0) {
    return entity.title.trim();
  }
  if (typeof entity.firstName === "string") nameParts.push(entity.firstName.trim());
  if (typeof entity.lastName === "string") nameParts.push(entity.lastName.trim());
  const combined = nameParts.filter(Boolean).join(" ").trim();
  if (combined.length > 0) return combined;
  if (typeof entity.username === "string" && entity.username.trim().length > 0) {
    return entity.username.trim();
  }
  return "Unnamed group";
}

function isGroupLike(dialog: any, entity: any): boolean {
  if (!entity) return false;
  if (dialog?.isGroup) return true;
  if (entity?.megagroup === true) return true;
  if (entity?.className === "Chat") return true;
  if (entity?.className === "Channel" && entity?.broadcast !== true) return true;
  return false;
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
    groupDirectory.clear();
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
    groupDirectory.clear();
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

async function resolvePeerForGroup(groupId: string): Promise<{ title: string; peer: any } | null> {
  if (!client || !isRunning) {
    throw new Error("Bot must be running to access group chats.");
  }

  let entry = groupDirectory.get(groupId);
  if (entry) {
    return entry;
  }

  try {
    await listGroupChats();
  } catch (e) {
    console.warn("Failed to refresh group cache:", (e as any)?.message || e);
  }

  entry = groupDirectory.get(groupId);
  return entry || null;
}

export async function listGroupChats(): Promise<GroupChatInfo[]> {
  if (!client || !isRunning) {
    throw new Error("Bot must be running to list group chats.");
  }

  const dialogs = await client
    .getDialogs({ limit: 200 })
    .catch((err: any) => {
      throw new Error(`Failed to fetch dialogs: ${err?.message || err}`);
    });

  groupDirectory.clear();
  const seen = new Set<string>();
  const results: GroupChatInfo[] = [];

  for (const dialog of dialogs) {
    try {
      const entity = (dialog as any)?.entity;
      if (!entity || !isGroupLike(dialog, entity)) continue;
      if (entity?.broadcast === true) continue; // skip read-only channels

      const idCandidate =
        toIdString((dialog as any)?.id) || toIdString(entity?.id) || toIdString(entity?.accessHash);
      if (!idCandidate || seen.has(idCandidate)) continue;

      let peer: any = null;
      try {
        peer = await client.getInputEntity(entity);
      } catch (e) {
        try {
          const fallback = (dialog as any)?.inputEntity;
          if (fallback) {
            peer = await client.getInputEntity(fallback);
          }
        } catch (inner) {
          console.warn("Failed to resolve input entity for group dialog:", (inner as any)?.message || inner);
        }
      }

      if (!peer) continue;

      const title = deriveDisplayTitle(entity);
      seen.add(idCandidate);
      groupDirectory.set(idCandidate, { title, peer });
      results.push({ id: idCandidate, title });
    } catch (err) {
      console.warn("Skipping dialog due to processing error:", (err as any)?.message || err);
    }
  }

  results.sort((a, b) => a.title.localeCompare(b.title));
  return results;
}

function buildUserNameMap(users: any[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(users)) return map;
  for (const user of users) {
    try {
      if (user instanceof Api.User || user?.className === "User") {
        const id = toIdString(user.id);
        if (!id) continue;
        const parts: string[] = [];
        if (typeof user.firstName === "string") parts.push(user.firstName.trim());
        if (typeof user.lastName === "string") parts.push(user.lastName.trim());
        const joined = parts.filter(Boolean).join(" ").trim();
        const fallback = typeof user.username === "string" ? user.username.trim() : "Member";
        map.set(id, joined.length > 0 ? joined : fallback.length > 0 ? fallback : "Member");
      }
    } catch {}
  }
  return map;
}

export async function broadcastGroupSentiment(groupId: string): Promise<SentimentBroadcastResponse> {
  if (!groupId || typeof groupId !== "string") {
    return { success: false, message: "A valid groupId must be provided." };
  }

  if (!client || !isRunning) {
    return { success: false, message: "Bot must be running to send group messages." };
  }

  const resolved = await resolvePeerForGroup(groupId);
  if (!resolved) {
    return { success: false, message: "Group not found or inaccessible." };
  }

  const { peer, title } = resolved;

  let history: any;
  try {
    history = await client.invoke(
      new Api.messages.GetHistory({
        peer,
        offsetId: 0,
        addOffset: 0,
        limit: 60,
        maxId: 0,
        minId: 0,
        hash: bigInt.zero,
      })
    );
  } catch (err) {
    const msg = (err as any)?.message || err;
    return { success: false, message: `Failed to load group history: ${msg}` };
  }

  const userMap = buildUserNameMap((history as any)?.users);
  const samples: SentimentSample[] = [];
  const messages = Array.isArray((history as any)?.messages) ? (history as any).messages : [];

  for (const item of messages) {
    try {
      if (!(item instanceof Api.Message)) continue;
      if (item.message === undefined || item.message === null) continue;
      if (item.out === true) continue;
      const text = String(item.message).trim();
      if (!text) continue;

      let authorId = null;
      if (item.fromId) {
        authorId = toIdString((item.fromId as any)?.userId ?? item.fromId);
      }

      const author = (authorId && userMap.get(authorId)) || title || "Member";
      const dateValue = Number(item.date);
      const timestamp = Number.isFinite(dateValue) ? dateValue * 1000 : undefined;
      samples.push({ author, text, timestamp });
    } catch {}
  }

  let generated: string;
  try {
    generated = await craftSentimentBlendMessage(samples);
  } catch (err) {
    const msg = (err as any)?.message || err;
    return { success: false, message: `Failed to generate message: ${msg}` };
  }

  try {
    await client.sendMessage(peer, { message: generated });
    recordOutbound(groupId, 0);
  } catch (err) {
    const msg = (err as any)?.message || err;
    return { success: false, message: `Failed to send message: ${msg}` };
  }

  return {
    success: true,
    message: "Sentiment-blended message sent successfully.",
    groupId,
    groupTitle: title,
    generated,
  };
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
    groupDirectory.clear();
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
