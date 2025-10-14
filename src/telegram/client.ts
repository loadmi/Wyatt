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
import { requestCustomCompletion, ChatMessage } from "../llm/llm";

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

export interface GroupChatSummary {
  id: string;
  title: string;
  unreadCount?: number;
}

export interface GroupBroadcastResult extends ControlResponse {
  generatedText?: string;
  usedFallback?: boolean;
}

type GroupCacheEntry = {
  inputPeer: any;
  title: string;
};

const groupCache = new Map<string, GroupCacheEntry>();

function ensureClientReady(): void {
  if (!client || !isRunning) {
    throw new Error("Bot must be running with an active session");
  }
}

function toIdString(value: any): string | null {
  try {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value.toString();
    if (typeof value === "bigint") return value.toString();
    if (typeof value?.toString === "function") {
      const str = value.toString();
      if (str && str !== "[object Object]") return str;
    }
  } catch (err) {
    console.warn("Failed to convert id to string", err);
  }
  return null;
}

function extractDialogTitle(entity: any): string {
  if (!entity) return "Unnamed group";
  if (typeof entity.title === "string" && entity.title.trim().length > 0) {
    return entity.title.trim();
  }
  const nameParts = [entity.firstName, entity.lastName].filter((part) => typeof part === "string" && part.trim().length > 0);
  if (nameParts.length > 0) {
    return nameParts.join(" ").trim();
  }
  if (typeof entity.username === "string" && entity.username.trim().length > 0) {
    return "@" + entity.username.trim();
  }
  return "Unnamed group";
}

function looksLikeGroup(dialog: any): boolean {
  if (!dialog) return false;
  if (dialog.isGroup === true || dialog.isChannel === true) return true;
  const entity = dialog.entity as any;
  const className = entity?.className || entity?.constructor?.name;
  if (className === "Channel" && entity?.megagroup) return true;
  if (className === "Channel" && entity?.broadcast === false) return true;
  if (className === "Chat") return true;
  return false;
}

async function resolveGroupPeer(groupId: string): Promise<GroupCacheEntry> {
  if (groupCache.has(groupId)) {
    return groupCache.get(groupId)!;
  }
  await listGroupChats();
  const entry = groupCache.get(groupId);
  if (!entry) {
    throw new Error("Group not found or inaccessible");
  }
  return entry;
}

async function buildGroupTranscript(inputPeer: any, title: string): Promise<{ transcript: string; usedMessages: number }> {
  const MAX_MESSAGES = 40;
  const MAX_CHARS = 3500;
  const collected: { author: string; text: string }[] = [];
  let charBudget = MAX_CHARS;

  try {
    for await (const message of client.iterMessages(inputPeer, { limit: MAX_MESSAGES })) {
      if (!message) continue;
      const text = typeof (message as any).message === "string" ? (message as any).message.trim() : "";
      if (!text) continue;
      const trimmed = text.replace(/\s+/g, " ").trim();
      if (!trimmed) continue;

      const textLen = trimmed.length;
      if (textLen > charBudget && collected.length > 0) {
        break;
      }

      let author = "Participant";
      if ((message as any).out === true) {
        author = "Bot";
      } else {
        try {
          const sender = typeof (message as any).getSender === "function" ? await (message as any).getSender() : (message as any).sender;
          if (sender) {
            if (sender.username) {
              author = "@" + String(sender.username);
            } else if (sender.firstName || sender.lastName) {
              author = [sender.firstName, sender.lastName].filter(Boolean).join(" ").trim() || author;
            } else if (sender.title) {
              author = String(sender.title);
            } else if (sender.id) {
              const id = toIdString(sender.id);
              if (id) author = `ID_${id}`;
            }
          } else if ((message as any).senderId) {
            const id = toIdString((message as any).senderId);
            if (id) author = `ID_${id}`;
          }
        } catch {
          // Ignore sender resolution errors
        }
      }

      collected.push({ author, text: trimmed });
      charBudget -= Math.min(charBudget, textLen);
      if (charBudget <= 0) break;
    }

    collected.reverse();
    const lines = collected.map((entry) => `${entry.author}: ${entry.text}`);
    const transcript = lines.join("\n");
    return { transcript, usedMessages: collected.length };
  } catch (err) {
    console.warn(`Failed to build transcript for group "${title}":`, err);
    return { transcript: "", usedMessages: 0 };
  }
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

export async function listGroupChats(): Promise<GroupChatSummary[]> {
  ensureClientReady();
  const summaries: GroupChatSummary[] = [];
  groupCache.clear();

  try {
    const dialogs = await client.getDialogs({ limit: 200 });
    for (const dialog of dialogs) {
      if (!looksLikeGroup(dialog)) continue;
      const entity = (dialog as any).entity;
      const id = toIdString(entity?.id) || toIdString((dialog as any)?.id);
      if (!id) continue;

      let inputPeer: any = undefined;
      try {
        inputPeer = (dialog as any).inputEntity || (await client.getInputEntity(entity));
      } catch (err) {
        console.warn(`Failed to resolve input entity for group ${id}:`, err);
        continue;
      }

      const title = extractDialogTitle(entity);
      const unreadCount = typeof (dialog as any).unreadCount === "number" ? (dialog as any).unreadCount : undefined;

      groupCache.set(id, { inputPeer, title });
      summaries.push({ id, title, unreadCount });
    }
  } catch (err) {
    console.warn("Failed to list group chats:", err);
    throw err;
  }

  summaries.sort((a, b) => a.title.localeCompare(b.title));
  return summaries;
}

export async function sendStealthGroupMessage(groupId: string): Promise<GroupBroadcastResult> {
  ensureClientReady();
  if (!groupId || typeof groupId !== "string") {
    return { success: false, message: "Invalid group id" };
  }

  try {
    const entry = await resolveGroupPeer(groupId);
    const { transcript, usedMessages } = await buildGroupTranscript(entry.inputPeer, entry.title);

    if (!transcript || transcript.trim().length === 0) {
      return { success: false, message: "No recent conversation history available to analyze." };
    }

    const systemPrompt =
      "You observe a Telegram group chat and craft a short, casual message that mirrors the average sentiment and tone. " +
      "Blend in as a regular participant, avoid sounding like a bot or analyst, and never mention that you studied the transcript.";

    const userPrompt =
      `Recent excerpts from the group "${entry.title}":\n` +
      `${transcript}\n\n` +
      "Write a single short message (ideally under 220 characters, one or two sentences) that matches the dominant mood. " +
      "If the sentiment is unclear, respond with a neutral friendly check-in. Avoid emojis unless conversation uses them frequently.";

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    const generated = await requestCustomCompletion(messages, {
      fallback: "Just checking in—hope everyone’s doing alright!",
      maxInputChars: 4000,
      maxSystemChars: 1000,
    });

    const clean = (generated || "").trim().slice(0, 500);
    if (!clean) {
      return { success: false, message: "LLM did not return any content." };
    }

    await client.sendMessage(entry.inputPeer, { message: clean });
    return {
      success: true,
      message: `Message sent to ${entry.title} using ${usedMessages} recent messages for context.`,
      generatedText: clean,
      usedFallback: clean === "Just checking in—hope everyone’s doing alright!",
    };
  } catch (err: any) {
    console.error("Failed to send stealth group message:", err);
    const errorMessage = err?.message ? String(err.message) : String(err);
    return { success: false, message: errorMessage };
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
