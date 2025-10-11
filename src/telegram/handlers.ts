// src/telegram/handlers.ts
import { NewMessage, NewMessageEvent } from "telegram/events";
import { Api } from "telegram";
import bigInt from "big-integer";
import { appConfig, randomInRange, sleep } from "../config";
import { getResponse } from "../llm/llm";


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
    if (x?.userId !== undefined) return toIdStringSafe(x.userId);
    if (x?.id !== undefined) return toIdStringSafe(x.id);
    if (x?.value !== undefined) return toIdStringSafe(x.value);
    if (typeof x.toString === "function") {
      const s = x.toString();
      return s && s !== "[object Object]" ? String(s) : null;
    }
  } catch {}
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
          } catch {}
        }
      }
    }
  } catch {}

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

  // Resolve input peer early since we need it for history lookups
  let inputPeer: any = undefined;
  inputPeer = await resolveInputPeerSafe(client, message);

  // Build conversation context: full history with this user
  let context: ContextEntry[] = [];
  try {
    if (inputPeer) {
      context = await fetchFullHistory(client, inputPeer, senderIdString);
    }
  } catch (e) {
    console.error("Failed to build context:", e);
  }

  let llmContext: LLMContextEntry[] = [];
  console.log("System Prompt:", appConfig().systemPrompt);
  llmContext = convertContextToLLM(context, appConfig().systemPrompt);


  console.log("Context:", llmContext);


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
  await sleep(waitBefore);

  // Phase 2: show typing for configured duration
  const typingFor = randomInRange(
    appConfig().typingDurationMs.min,
    appConfig().typingDurationMs.max
  );
  const stopTyping = startTyping();
  await sleep(typingFor);

  // Phase 3: send reply and stop typing
  try {
    const isGroupContext = isPeerChatOrChannel(message?.peerId);
    const sendOptions: any = { message: replyText };
    if (isGroupContext) {
      sendOptions.replyTo = (message as any).id;
    }
    await client.sendMessage(inputPeer || message.peerId, sendOptions);

    console.log(`Replied to ${senderIdString}: "${replyText}"`);
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
      console.log(`Replied via API to ${senderIdString}: "${replyText}"`);
    } catch (apiError) {
      console.error("API fallback also failed:", apiError);
    }
  } finally {
    stopTyping();
  }
  // TODO: Add logic to delete or end chat in some cases
}
