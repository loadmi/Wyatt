import { appConfig } from "../config";
import { recordLLMRequest } from "../metrics";

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
type SentimentSource = { author: string; text: string };

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
  const key = process.env.OPENROUTER_API_KEY || '';
  if (!key) {
    console.warn('[LLM] OpenRouter key missing. Set OPENROUTER_API_KEY in .env');
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

function normalizeConversationEntries(entries: SentimentSource[]): SentimentSource[] {
  return entries
    .map((entry) => {
      const author = (entry?.author || '').toString().trim() || 'Participant';
      const text = (entry?.text || '').toString().replace(/\s+/g, ' ').trim();
      return { author, text };
    })
    .filter((entry) => entry.text.length > 0);
}

export async function generateGroupSentimentMessage(entries: SentimentSource[]): Promise<string> {
  const sanitized = normalizeConversationEntries(entries);
  if (sanitized.length === 0) {
    return 'Hey everyone! Just dropping by to see how things are going.';
  }

  const fallbackResponses = [
    'Hope everyone is having a smooth one—just checking in quietly. 👋',
    'Just touching base with the group—hope things are rolling along nicely.',
    'Appreciate the vibes here, figured I’d chime in and stay in the loop.',
  ];
  const fallback = fallbackResponses[Math.floor(Math.random() * fallbackResponses.length)];

  const maxChars = Number.isFinite(Number(process.env.GROUP_SENTIMENT_PROMPT_CHARS))
    ? Number(process.env.GROUP_SENTIMENT_PROMPT_CHARS)
    : 5600;

  let running = 0;
  const selected: SentimentSource[] = [];
  for (let i = sanitized.length - 1; i >= 0; i -= 1) {
    const entry = sanitized[i];
    const contribution = entry.author.length + entry.text.length + 5;
    if (selected.length > 0 && running + contribution > maxChars) {
      break;
    }
    selected.push(entry);
    running += contribution;
    if (selected.length >= 80) {
      break;
    }
  }
  selected.reverse();

  const transcript = selected
    .map((entry, idx) => `${idx + 1}. ${entry.author}: ${entry.text}`)
    .join('\n');

  const instruction =
    'You study the provided group conversation and craft a short message that subtly matches the overall tone and sentiment.' +
    ' Blend in, avoid sounding like a bot, and keep it under 3 short sentences. Do not mention analysis or that this is generated.' +
    ' Keep it friendly, neutral, and unsuspicious.';

  const prompt: ChatMessage[] = [
    { role: 'system', content: instruction },
    {
      role: 'user',
      content:
        'Here is the recent chat transcript, oldest to newest. Compose one stealthy reply that fits the average mood:\n' +
        transcript,
    },
  ];

  const trimmed = trimMessagesToLimit(prompt, maxChars, Math.min(2000, maxChars));

  console.log('[LLM] Request: group sentiment mimic');
  const result = await callProvider(trimmed);
  if (result.ok && result.text) {
    console.log('[LLM] Final: group sentiment response');
    return result.text;
  }

  console.log('[LLM] Final: fallback group sentiment response');
  return fallback;
}

export async function getResponse(messages: ChatMessage[]): Promise<string> {
  const mi = Number(process.env.LLM_MAX_INPUT_CHARS);
  const ms = Number(process.env.LLM_MAX_SYSTEM_CHARS);
  const MAX_INPUT_CHARS = Number.isFinite(mi) ? mi : 4900;
  const MAX_SYSTEM_CHARS = Number.isFinite(ms) ? ms : 4900;
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
    const prepared = trimMessagesToLimit(messages as ChatMessage[], MAX_INPUT_CHARS, MAX_SYSTEM_CHARS);
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
