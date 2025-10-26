// src/utils/logSanitizer.ts

/**
 * Sanitizes sensitive data from logs to prevent accidental exposure of:
 * - API keys and tokens
 * - Session strings
 * - Phone numbers
 * - Full message content (truncated to prevent log spam)
 */

// Patterns to detect and redact sensitive data
const SENSITIVE_PATTERNS = [
  // API keys (various formats)
  { pattern: /\b[A-Za-z0-9_-]{32,}\b/g, replacement: '[REDACTED_KEY]' },
  // Session strings (base64-like long strings)
  { pattern: /\b[A-Za-z0-9+/=]{100,}\b/g, replacement: '[REDACTED_SESSION]' },
  // Phone numbers (international format)
  { pattern: /\+?\d{10,15}/g, replacement: '[REDACTED_PHONE]' },
  // Email addresses
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, replacement: '[REDACTED_EMAIL]' },
];

// Keys that should be completely redacted in objects
const SENSITIVE_KEYS = [
  'apikey',
  'api_key',
  'apiHash',
  'api_hash',
  'sessionstring',
  'session_string',
  'password',
  'token',
  'secret',
  'authorization',
  'auth',
];

/**
 * Sanitizes a string by redacting sensitive patterns
 */
function sanitizeString(str: string, maxLength: number = 100): string {
  if (typeof str !== 'string') {
    return String(str);
  }

  let sanitized = str;

  // Apply all sensitive patterns
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }

  // Truncate long strings to prevent log spam
  if (sanitized.length > maxLength) {
    return `${sanitized.slice(0, maxLength)}... [truncated ${sanitized.length - maxLength} chars]`;
  }

  return sanitized;
}

/**
 * Sanitizes an object by redacting sensitive keys and values
 */
function sanitizeObject(obj: any, maxDepth: number = 3, currentDepth: number = 0): any {
  if (currentDepth >= maxDepth) {
    return '[MAX_DEPTH_REACHED]';
  }

  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj !== 'object') {
    return sanitizeString(String(obj));
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item, maxDepth, currentDepth + 1));
  }

  const sanitized: any = {};

  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();

    // Check if this key should be completely redacted
    if (SENSITIVE_KEYS.some(sensitiveKey => lowerKey.includes(sensitiveKey))) {
      sanitized[key] = '[REDACTED]';
      continue;
    }

    // Recursively sanitize nested objects
    if (value && typeof value === 'object') {
      sanitized[key] = sanitizeObject(value, maxDepth, currentDepth + 1);
    } else if (typeof value === 'string') {
      sanitized[key] = sanitizeString(value);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Main sanitization function that handles any data type
 * @param data - The data to sanitize (can be string, object, error, etc.)
 * @param options - Optional configuration
 * @returns A sanitized string representation safe for logging
 */
export function sanitizeForLog(
  data: any,
  options: {
    maxLength?: number;
    maxDepth?: number;
    truncateMessages?: boolean;
  } = {}
): string {
  const {
    maxLength = 100,
    maxDepth = 3,
    truncateMessages = true,
  } = options;

  try {
    // Handle null/undefined
    if (data === null) return 'null';
    if (data === undefined) return 'undefined';

    // Handle errors
    if (data instanceof Error) {
      const errorObj = {
        name: data.name,
        message: sanitizeString(data.message, maxLength),
        stack: data.stack ? '[STACK_TRACE_OMITTED]' : undefined,
      };
      return JSON.stringify(errorObj, null, 2);
    }

    // Handle strings
    if (typeof data === 'string') {
      return sanitizeString(data, truncateMessages ? maxLength : data.length);
    }

    // Handle primitives
    if (typeof data !== 'object') {
      return String(data);
    }

    // Handle objects
    const sanitized = sanitizeObject(data, maxDepth);
    return JSON.stringify(sanitized, null, 2);
  } catch (error) {
    // Fallback if sanitization itself fails
    return '[SANITIZATION_ERROR]';
  }
}

/**
 * Sanitizes message text specifically (truncates to prevent log spam)
 */
export function sanitizeMessageText(text: string, maxLength: number = 100): string {
  if (typeof text !== 'string') {
    return '[NON_STRING_MESSAGE]';
  }

  const sanitized = sanitizeString(text, text.length); // Don't truncate during pattern matching

  if (sanitized.length > maxLength) {
    return `${sanitized.slice(0, maxLength)}... [${sanitized.length} chars total]`;
  }

  return sanitized;
}

/**
 * Sanitizes configuration objects (redacts sensitive fields)
 */
export function sanitizeConfig(config: any): string {
  return sanitizeForLog(config, {
    maxLength: 200,
    maxDepth: 4,
    truncateMessages: false,
  });
}