import fs from 'fs';
import path from 'path';
import type { TelegramAccount } from './config';

export type PersistedState = {
   currentPersona?: string;
   llmProvider?: 'pollinations' | 'openrouter';
   openrouterModel?: string;
   // Secret for OpenRouter (never returned to clients). Stored locally.
   openrouterApiKey?: string;
   // Store resolved system prompt text to avoid dynamic imports at boot
   systemPrompt?: string;
   telegramAccounts?: TelegramAccount[];
   activeAccountId?: string | null;
   // Track last interaction times per user/chat for wake up functionality
   interactionTracker?: Record<string, { lastInteraction: number; chatId: string }>;
   wakeUpEscalationChatId?: string;
   wakeUpEscalationLabel?: string;
   wakeUpSuggestionCount?: number;
   chatPersonalities?: Record<string, {
     personaId: string;
     systemPrompt: string;
     updatedAt: number;
     createdAt?: number;
   }>;
 };

function stateFilePath(): string {
  const dir = path.join(process.cwd(), 'data');
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch (e) {
    // If directory creation fails, fallback to project root file
    return path.join(process.cwd(), 'app.config.json');
  }
  return path.join(dir, 'config.json');
}

export function loadPersistedState(): PersistedState {
  const file = stateFilePath();
  try {
    if (!fs.existsSync(file)) {
      // Create an empty config file on first run for smoother setup
      try {
        fs.writeFileSync(file, JSON.stringify({}, null, 2), 'utf-8');
      } catch {
        // Ignore write errors here; subsequent saves will try again
      }
      return {};
    }
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as PersistedState;
  } catch (e) {
    console.warn('Failed to load persisted state:', (e as any)?.message || e);
    return {};
  }
}

export function savePersistedState(partial: PersistedState): void {
  const file = stateFilePath();
  try {
    let current: PersistedState = {};
    if (fs.existsSync(file)) {
      try {
        const raw = fs.readFileSync(file, 'utf-8');
        current = JSON.parse(raw) || {};
      } catch {
        current = {};
      }
    }
    const next = { ...current, ...partial } as PersistedState;
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf-8');
  } catch (e) {
    console.warn('Failed to save persisted state:', (e as any)?.message || e);
  }
}
