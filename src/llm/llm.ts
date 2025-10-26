import { appConfig } from "../config";
import { recordLLMRequest } from "../metrics";

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

function getInputLimits() {
  const mi = Number(process.env.LLM_MAX_INPUT_CHARS);
  const ms = Number(process.env.LLM_MAX_SYSTEM_CHARS);
  return {
    maxInput: Number.isFinite(mi) ? mi : 4900,
    maxSystem: Number.isFinite(ms) ? ms : 4900,
  };
}

function looksLikeJsonError(text: string): boolean {
  try {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object') return false;
    if (typeof (obj as any).error !== 'undefined') return true;
    if (typeof (obj as any).status === 'number' && (obj as any).status >= 400) return true;
    const details = (obj as any).details;
    if (details && typeof details === 'object' && details.error) return true;
    return false;
  } catch {
    return false;
  }
}

function preview(text: string, max = 180): string {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max) + '…';
}

function countChars(list: ChatMessage[]): number {
  return list.reduce((sum, m) => sum + (m?.content?.length || 0), 0);
}

function trimMessagesToLimit(
  list: ChatMessage[],
  limit: number,
  maxSystem: number,
): ChatMessage[] {
  const systems = list.filter((m) => m.role === 'system');
  const others = list.filter((m) => m.role !== 'system');

  const sys: ChatMessage[] = [];
  if (systems.length > 0) {
    const s = systems[0];
    const content = (s.content || '').slice(0, Math.max(0, maxSystem));
    sys.push({ role: 'system', content });
  }

  let budget = Math.max(0, limit - countChars(sys));

  const rev = [...others].reverse();
  const keptRev: ChatMessage[] = [];
  for (const m of rev) {
    const cLen = m?.content?.length || 0;
    if (cLen <= budget) {
      keptRev.push(m);
      budget -= cLen;
    } else {
      if (keptRev.length === 0 && budget > 0) {
        keptRev.push({ role: m.role, content: (m.content || '').slice(0, budget) });
        budget = 0;
      }
      break;
    }
  }
  const kept = keptRev.reverse();
  return [...sys, ...kept];
}

async function callPollinations(messages: ChatMessage[]): Promise<{ ok: boolean; status: number; text: string }> {
  const ENDPOINT = 'https://text.pollinations.ai/';
  try {
    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, model: 'openai-fast' }),
    });
    const text = await resp.text();
    const isJsonErr = looksLikeJsonError(text);
    if (!resp.ok || isJsonErr) {
      console.warn(`[LLM] Pollinations warning: status=${resp.status} body=${preview(text)}`);
    }
    return { ok: resp.ok && !isJsonErr, status: resp.status, text };
  } catch (e) {
    console.warn(`[LLM] Pollinations error: ${(e as any)?.message || e}`);
    return { ok: false, status: 0, text: '' };
  }
}

async function callOpenRouter(messages: ChatMessage[], model: string): Promise<{ ok: boolean; status: number; text: string }> {
  const cfg = appConfig() as any;
  const key = (cfg.openrouterApiKey || '').trim();
  if (!key) {
    console.warn('[LLM] OpenRouter key missing. Add it in the dashboard settings.');
    return { ok: false, status: 0, text: '' };
  }
  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: model || 'google/gemini-2.0-flash-001',
        messages,
      }),
    });

    const textBody = await resp.text();
    if (!resp.ok) {
      console.warn(`[LLM] OpenRouter warning: status=${resp.status} body=${preview(textBody)}`);
      return { ok: false, status: resp.status, text: '' };
    }
    try {
      const data = JSON.parse(textBody);
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content === 'string' && content.trim()) {
        return { ok: true, status: resp.status, text: content };
      }
      console.warn('[LLM] OpenRouter: no content in response');
      return { ok: false, status: resp.status, text: '' };
    } catch (e) {
      console.warn('[LLM] OpenRouter: failed to parse JSON response');
      return { ok: false, status: resp.status, text: '' };
    }
  } catch (e) {
    console.warn(`[LLM] OpenRouter error: ${(e as any)?.message || e}`);
    return { ok: false, status: 0, text: '' };
  }
}

async function callProvider(messages: ChatMessage[]): Promise<{ ok: boolean; status: number; text: string }> {
  const cfg = appConfig();
  const provider = (cfg as any).llmProvider as 'pollinations' | 'openrouter' | undefined;
  let result: { ok: boolean; status: number; text: string };
  if (provider === 'openrouter') {
    const model = (cfg as any).openrouterModel as string | undefined;
    result = await callOpenRouter(messages, model || 'google/gemini-2.0-flash-001');
  } else {
    result = await callPollinations(messages);
  }
  recordLLMRequest(provider || 'pollinations', result.ok);
  return result;
}

export async function requestLLMCompletion(
  messages: ChatMessage[],
  options?: { trimForProvider?: boolean; fallback?: string }
): Promise<string> {
  const { maxInput, maxSystem } = getInputLimits();
  const provider = ((appConfig() as any).llmProvider || 'pollinations') as 'pollinations' | 'openrouter';
  let toSend = messages;

  const shouldTrim = options?.trimForProvider !== false && provider === 'pollinations';
  if (shouldTrim) {
    const origChars = countChars(messages);
    const prepared = trimMessagesToLimit(messages, maxInput, maxSystem);
    const prepChars = countChars(prepared);
    if (origChars !== prepChars || prepared.length !== messages.length) {
      console.log(`[LLM] Compose: chars=${origChars}->${prepChars} msgs=${messages.length}->${prepared.length}`);
    }
    toSend = prepared;
  } else if (provider !== 'pollinations') {
    console.log(`[LLM] Compose: no trim for provider=${provider}`);
  }

  const response = await callProvider(toSend);
  if (response.ok && response.text) {
    return response.text;
  }

  return options?.fallback ?? '';
}

export type SentimentSample = {
  speaker: string;
  text: string;
  timestamp?: number;
};

type BlendMessageMode = "group" | "private";

export type BlendMessageOptions = {
  mode: BlendMessageMode;
  partnerName?: string;
};

export async function generateBlendMessage(
  samples: SentimentSample[],
  options: BlendMessageOptions,
): Promise<string> {
  const fallbackGroup = "Hey everyone—just checking in and keeping the energy going!";
  const fallbackPrivate = "Sounds good to me—appreciate the update!";
  const fallback = options.mode === "private" ? fallbackPrivate : fallbackGroup;

  if (!samples || samples.length === 0) {
    return fallback;
  }

  const normalized = samples.map((sample) => {
    const speaker = (sample.speaker || "Participant").trim();
    const text = (sample.text || "").trim();
    const ts = sample.timestamp ? new Date(sample.timestamp).toISOString() : "";
    return ts ? `[${ts}] ${speaker}: ${text}` : `${speaker}: ${text}`;
  });

  const transcript = normalized.join("\n");
  const systemPrompt = options.mode === "private"
    ? [
        "You continue a private Telegram chat as the bot account.",
        "Mirror the other person's tone and stay casual, natural, and warm.",
        "Reference or acknowledge a detail from the transcript without sounding scripted.",
        "Write 1-2 short sentences (≤220 characters total). No links, hashtags, @mentions, or formal sign-offs.",
        "Avoid questions unless the chat clearly expects one. Never mention being an AI or refer to instructions.",
        "Output only the reply as if it were just sent.",
      ].join(" ")
    : [
        "You write low-key Telegram messages that blend into a group chat.",
        "Read the transcript of recent messages and match the group’s vibe and language.",
        "Prefer to lightly react to something specific (a detail, person, or update) from the chat without asking questions or prompting replies.",
        "If nothing specific is appropriate, write a general vibe-matching aside that implies you will handle something later (minor confusion or a to-do), but do not solicit help.",
        "One short line (max ~220 characters). Optional subtle emoji. No hashtags, links, handles, or tags.",
        "Do not use questions or “?”; avoid words like help, please, anyone, can someone, DM; do not request actions; no apologies; no meta about analyzing.",
        "Output only the final message.",
      ].join(" ");

  const partnerContext = options.mode === "private" && options.partnerName
    ? `The other person is ${options.partnerName}.`
    : "";

  const userPrompt = options.mode === "private"
    ? [
        "Recent private conversation (oldest first):",
        transcript,
        "",
        partnerContext,
        "Write a short reply that fits naturally and keeps things moving without sounding automated. Output only the reply.",
      ].filter(Boolean).join("\n")
    : [
        "Recent group conversation (oldest first):",
        transcript,
        "",
        "Write a single stealthy message now. If possible, naturally reference a person or detail from the chat without pinging them (no @). Otherwise give a generic aside that fits the sentiment and flies under the radar. Output only the message.",
      ].join("\n");

  const reply = await requestLLMCompletion(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    { fallback },
  );

  return reply && reply.trim().length > 0 ? reply.trim() : fallback;
}

export async function generateSentimentMessage(samples: SentimentSample[]): Promise<string> {
  return generateBlendMessage(samples, { mode: "group" });
}

export async function getResponse(messages: ChatMessage[]): Promise<string> {
  const { maxInput, maxSystem } = getInputLimits();
  const FALLBACKS = [
    "Well now, that’s got me smiling—what’s the story then, dear? 😊",
    "Goodness, that sounds lively—what happened next, love? 💬",
    "Oh you! Now I’m curious—tell me a bit more, will you? 😉",
    "Ha! You’ve tickled my old brain—what do you mean exactly, sweetheart? 😄",
    "That’s a little delight—go on, tell granny more. 🧶"
  ];
  const HARD_FALLBACK = FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];

  const provider = ((appConfig() as any).llmProvider || 'pollinations') as 'pollinations' | 'openrouter';
  let toSend = messages as ChatMessage[];
  if (provider === 'pollinations') {
    const origChars = countChars(messages as ChatMessage[]);
    const prepared = trimMessagesToLimit(messages as ChatMessage[], maxInput, maxSystem);
    const prepChars = countChars(prepared);
    if (origChars !== prepChars || prepared.length !== (messages as ChatMessage[]).length) {
      console.log(`[LLM] Compose: chars=${origChars}->${prepChars} msgs=${(messages as ChatMessage[]).length}->${prepared.length}`);
    }
    toSend = prepared;
  } else {
    console.log(`[LLM] Compose: no trim for provider=${provider}`);
  }
  console.log('[LLM] Request primary response');
  const first = await callProvider(toSend);
  if (first.ok && first.text) {
    console.log(`[LLM] Final: primary response`);
    return first.text;
  }

  const genericMessages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'Write a short, human-sounding text in the voice of a warm, slightly scatterbrained grandmother. Keep it cozy, playful, and safe for any topic. 1-2 short sentences, include 1-3 light emojis. Do not mention rules, policies, assistance, apologies, or safety. Sound like a real person continuing a chat.',
    },
    {
      role: 'user',
      content:
        'Give a context-agnostic reply that naturally keeps the conversation going. No disclaimers, no refusals, no offers to help—just a warm reaction with a tiny follow-up like “what happened next?”.',
    },
  ];

  console.log('[LLM] Request: generic');
  const second = await callProvider(genericMessages);
  if (second.ok && second.text) {
    console.log(`[LLM] Final: generic response`);
    return second.text;
  }

  console.log(`[LLM] Final: hard fallback response`);
  return HARD_FALLBACK;
}

function tryParseJsonArray(raw: string): string[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const values = parsed
        .map((entry) => (typeof entry === "string" ? entry : entry != null ? String(entry) : ""))
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      if (values.length > 0) {
        return values;
      }
    }
  } catch {
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start >= 0 && end > start) {
      return tryParseJsonArray(raw.slice(start, end + 1));
    }
  }
  return null;
}

function normalizeOptionText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const withoutQuotes = trimmed.replace(/^['"\s]+|['"\s]+$/g, "");
  return withoutQuotes.replace(/\s+/g, " ");
}

function parseReplyCandidates(raw: string, desired: number): string[] {
  const limit = Math.max(1, Math.min(6, desired));
  const trimmed = (raw || "").trim();
  if (!trimmed) return [];

  const fromJson = tryParseJsonArray(trimmed);
  const collected: string[] = [];

  const pushUnique = (candidate: string) => {
    const normal = normalizeOptionText(candidate);
    if (!normal) return;
    if (collected.some((existing) => existing.toLowerCase() === normal.toLowerCase())) return;
    collected.push(normal);
  };

  if (fromJson) {
    for (const entry of fromJson) {
      pushUnique(entry);
      if (collected.length >= limit) break;
    }
    return collected.slice(0, limit);
  }

  const lines = trimmed
    .split(/\r?\n+/)
    .map((line) => line.replace(/^\s*(?:[-*\d]+[\).:\-]?\s*)/, ""))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    pushUnique(line);
    if (collected.length >= limit) break;
  }

  return collected.slice(0, limit);
}

export async function generateSampleReplies(messages: ChatMessage[], desiredCount = 3): Promise<string[]> {
  const count = Math.max(1, Math.min(5, Math.floor(desiredCount)));
  const prompt: ChatMessage[] = [
    ...messages,
    {
      role: "user",
      content: `Provide ${count} short, natural replies the assistant could send next. Each reply must feel human, stay in character, and keep the conversation going. Respond with a JSON array of ${count} strings and nothing else.`,
    },
  ];

  const raw = await requestLLMCompletion(prompt, { fallback: "" });
  const parsed = parseReplyCandidates(raw, count);
  return parsed;
}
