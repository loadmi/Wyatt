// src/config.ts
// Centralized application configuration and simple helpers

type NumRange = { min: number; max: number };

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const appConfig = {
  // Initial silent wait before showing typing
  waitBeforeTypingMs: {
    min: envNumber("WAIT_BEFORE_TYPING_MS_MIN", 10_000),
    max: envNumber("WAIT_BEFORE_TYPING_MS_MAX", 15_000),
  } as NumRange,

  // Duration to display typing indicator before sending
  typingDurationMs: {
    min: envNumber("TYPING_DURATION_MS_MIN", 10_000),
    max: envNumber("TYPING_DURATION_MS_MAX", 15_000),
  } as NumRange,

  // How often to refresh the typing indicator (Telegram expects ~every 5s or less)
  typingKeepaliveMs: envNumber("TYPING_KEEPALIVE_MS", 4_000),
};

export function randomInRange(min: number, max: number): number {
  if (max <= min) return min;
  const span = max - min;
  return Math.floor(min + Math.random() * span);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

