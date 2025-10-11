// src/config.ts
// Centralized application configuration and simple helpers
import granny from "./llm/personas/granny.json";

type NumRange = { min: number; max: number };

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  // Initial silent wait before showing typing
  waitBeforeTypingMs: {
    min: envNumber("WAIT_BEFORE_TYPING_MS_MIN", 1_000),
    max: envNumber("WAIT_BEFORE_TYPING_MS_MAX", 1_000),
  } as NumRange,

  // Duration to display typing indicator before sending
  typingDurationMs: {
    min: envNumber("TYPING_DURATION_MS_MIN", 1_000),
    max: envNumber("TYPING_DURATION_MS_MAX", 1_000),
  } as NumRange,

  // How often to refresh the typing indicator (Telegram expects ~every 5s or less)
  typingKeepaliveMs: envNumber("TYPING_KEEPALIVE_MS", 4_000),
  systemPrompt: JSON.stringify(granny),
};


export const appConfig = () => config;

export function randomInRange(min: number, max: number): number {
  if (max <= min) return min;
  const span = max - min;
  return Math.floor(min + Math.random() * span);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


export function setConfig(newConfig: Partial<typeof config>): void {
  Object.assign(config, newConfig);
  console.log("Config Updated");

}
