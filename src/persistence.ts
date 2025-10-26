import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import type { TelegramAccount, SupervisorConfig, MessageDelaysConfig } from './config';

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
   /** @deprecated Use supervisor.contact instead */
   humanEscalationChatId?: string;
   supervisor?: Partial<SupervisorConfig>;
   messageDelays?: Partial<MessageDelaysConfig>;
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
    // Use sync version for directory check since this is called synchronously
    if (!fsSync.existsSync(dir)) {
      fsSync.mkdirSync(dir, { recursive: true });
    }
  } catch (error) {
    // If directory creation fails, fallback to project root file
    console.warn('Failed to create data directory, using fallback location:', (error as Error)?.message || error);
    return path.join(process.cwd(), 'app.config.json');
  }
  return path.join(dir, 'config.json');
}

export async function loadPersistedState(): Promise<PersistedState> {
  const file = stateFilePath();
  try {
    // Check if file exists using async stat
    try {
      await fs.access(file);
    } catch {
      // File doesn't exist, create an empty config file on first run for smoother setup
      try {
        await fs.writeFile(file, JSON.stringify({}, null, 2), 'utf-8');
      } catch {
        // Ignore write errors here; subsequent saves will try again
      }
      return {};
    }
    
    const raw = await fs.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as PersistedState;
  } catch (e) {
    console.warn('Failed to load persisted state:', (e as any)?.message || e);
    return {};
  }
}

export async function savePersistedState(partial: PersistedState): Promise<void> {
  const file = stateFilePath();
  try {
    let current: PersistedState = {};
    
    // Check if file exists and read current state
    try {
      await fs.access(file);
      const raw = await fs.readFile(file, 'utf-8');
      current = JSON.parse(raw) || {};
    } catch {
      // File doesn't exist or couldn't be read, start with empty state
      current = {};
    }
    
    const next = { ...current, ...partial } as PersistedState;
    await fs.writeFile(file, JSON.stringify(next, null, 2), 'utf-8');
  } catch (e) {
    console.warn('Failed to save persisted state:', (e as any)?.message || e);
  }
}
