// src/telegram/idUtils.ts
// Consolidated ID conversion utilities to ensure consistency across the codebase

/**
 * Safely converts various ID formats to a stable string representation.
 * Handles bigint, number, string, and Telegram API objects.
 * @param raw - The raw ID value to convert
 * @returns A string representation of the ID, or null if conversion fails
 */
export function toIdString(raw: any): string | null {
  try {
    if (raw === null || raw === undefined) return null;
    
    // Direct primitive types
    if (typeof raw === "string") return raw;
    if (typeof raw === "number" || typeof raw === "bigint") return String(raw);
    
    // Telegram API objects - prefer specific ID fields
    // Order matters: check most specific fields first
    if (raw?.channelId !== undefined && raw?.channelId !== null) {
      return toIdString(raw.channelId);
    }
    if (raw?.chatId !== undefined && raw?.chatId !== null) {
      return toIdString(raw.chatId);
    }
    if (raw?.userId !== undefined && raw?.userId !== null) {
      return toIdString(raw.userId);
    }
    
    // Generic id field
    if (raw?.id !== undefined && raw?.id !== null) {
      return toIdString(raw.id);
    }
    
    // Value wrapper objects
    if (raw?.value !== undefined && raw?.value !== null) {
      return toIdString(raw.value);
    }
    
    // Last resort: toString() method
    if (typeof raw.toString === "function") {
      const str = raw.toString();
      return str && str !== "[object Object]" ? String(str) : null;
    }
  } catch {
    // Silently handle any conversion errors
  }
  
  return null;
}

/**
 * Resolves a stable chat/dialog key from Telegram entities.
 * Prefers numeric IDs for consistency with Telegram's internal representation.
 * @param entity - The Telegram entity (User, Chat, Channel, etc.)
 * @param dialog - Optional dialog object for fallback
 * @returns A stable string key for the chat, or null if resolution fails
 */
export function toStableChatKey(entity: any, dialog?: any): string | null {
  try {
    // Prefer explicit peer-specific fields first
    if (entity?.userId !== undefined && entity?.userId !== null) {
      return toIdString(entity.userId);
    }
    if (entity?.channelId !== undefined && entity?.channelId !== null) {
      return toIdString(entity.channelId);
    }
    if (entity?.chatId !== undefined && entity?.chatId !== null) {
      return toIdString(entity.chatId);
    }
    
    // Fall back to generic entity.id (typically numeric for Users/Chats/Channels)
    if (entity?.id !== undefined && entity?.id !== null) {
      return toIdString(entity.id);
    }
    
    // Last resort: dialog.id if present
    if (dialog?.id !== undefined && dialog?.id !== null) {
      return toIdString(dialog.id);
    }
  } catch {
    // Silently handle any resolution errors
  }
  
  return null;
}

/**
 * Legacy alias for toIdString to maintain backward compatibility.
 * @deprecated Use toIdString instead
 */
export const toIdStringSafe = toIdString;

/**
 * Legacy alias for toIdString to maintain backward compatibility.
 * @deprecated Use toIdString instead
 */
export const toDialogKey = toIdString;