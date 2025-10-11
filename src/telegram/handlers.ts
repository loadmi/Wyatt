// src/telegram/handlers.ts
import { NewMessage, NewMessageEvent } from "telegram/events";
import { Api } from "telegram";
import bigInt from "big-integer";
import { appConfig, randomInRange, sleep } from "../config";

interface ConversationState {
  step: number;
}
const conversations = new Map<string, ConversationState>();

const conversationFlow: string[] = [
  "Hello? Who is this?",
  "Oh, I see. How did you get my number?",
  "I'm not sure I remember you. What is this about?",
  "Okay, I'm listening...",
  "That sounds... interesting. Tell me more.",
];

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

  let convoState = conversations.get(senderIdString);
  if (!convoState) {
    convoState = { step: 0 };
  }

  const replyText =
    conversationFlow[convoState.step] ||
    "Sorry, I need to go now. Talk later.";

  // Resolve input peer for the chat to avoid entity errors
  let inputPeer: any = undefined;
  try {
    inputPeer = await (message as any).getInputChat?.();
  } catch (e) {
    console.error("Failed to resolve input peer from message:", e);
  }

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
        .catch(() => {});

    // Fire immediately, then keep alive per config
    sendTyping();
    const interval = setInterval(sendTyping, appConfig.typingKeepaliveMs);

    return () => {
      clearInterval(interval);
      (client as any)
        .invoke(
          new Api.messages.SetTyping({
            peer,
            action: new Api.SendMessageCancelAction(),
          })
        )
        .catch(() => {});
    };
  };

  // Phase 1: silent wait before typing
  const waitBefore = randomInRange(
    appConfig.waitBeforeTypingMs.min,
    appConfig.waitBeforeTypingMs.max
  );
  await sleep(waitBefore);

  // Phase 2: show typing for configured duration
  const typingFor = randomInRange(
    appConfig.typingDurationMs.min,
    appConfig.typingDurationMs.max
  );
  const stopTyping = startTyping();
  await sleep(typingFor);

  // Phase 3: send reply and stop typing
  try {
    await client.sendMessage(inputPeer || message.peerId, {
      message: replyText,
      //replyTo: (message as any).id,
    });

    console.log(`Replied to ${senderIdString}: "${replyText}"`);
  } catch (error) {
    console.error("Failed to send message:", error);
    
    // Fallback: try using the API directly
    try {
      await client.invoke(
        new Api.messages.SendMessage({
          peer: inputPeer || message.peerId,
          message: replyText,
          // replyTo: new Api.InputReplyToMessage({ replyToMsgId: message.id }),
          randomId: bigInt(Math.floor(Math.random() * 1e16)),
        })
      );
      console.log(`�o. Replied via API to ${senderIdString}: "${replyText}"`);
    } catch (apiError) {
      console.error("�?O API fallback also failed:", apiError);
    }
  } finally {
    stopTyping();
  }

  convoState.step++;
  conversations.set(senderIdString, convoState);

  if (convoState.step >= conversationFlow.length) {
    conversations.delete(senderIdString);
  }
}

