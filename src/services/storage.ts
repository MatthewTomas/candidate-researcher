/**
 * localStorage persistence with versioned keys.
 * API keys are encrypted at rest with AES-GCM (password-derived).
 */

import type { AppSettings, CandidateSession, BatchQueueItem } from '../types';
import { DEFAULT_SETTINGS } from '../types';
import {
  encrypt,
  decrypt,
  getStoredPassword,
  isEncryptedPayload,
  type EncryptedPayload,
} from './crypto';

const STORAGE_PREFIX = 'branch_playground';
const SETTINGS_KEY = `${STORAGE_PREFIX}_settings_v1`;
const SESSIONS_KEY = `${STORAGE_PREFIX}_sessions_v1`;
const ACTIVE_SESSION_KEY = `${STORAGE_PREFIX}_active_session_id`;
const ENCRYPTED_KEYS_KEY = `${STORAGE_PREFIX}_encrypted_keys`;
const BATCH_QUEUE_KEY = `${STORAGE_PREFIX}_batch_queue_v1`;

// --- Active Session ID ---

export function loadActiveSessionId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_SESSION_KEY);
  } catch {
    return null;
  }
}

export function saveActiveSessionId(id: string | null): void {
  try {
    if (id) {
      localStorage.setItem(ACTIVE_SESSION_KEY, id);
    } else {
      localStorage.removeItem(ACTIVE_SESSION_KEY);
    }
  } catch {
    console.warn('Failed to save active session ID');
  }
}

// --- Model ID migrations (fix stale cached values) ---

const MODEL_ID_MIGRATIONS: Record<string, string> = {
  'gemini-3.0-pro-preview': 'gemini-3-pro-preview',
  'gemini-3.0-flash-preview': 'gemini-3-flash-preview',
  'gemini-2.0-flash': 'gemini-2.0-flash',          // keep as-is (2.0 is correct)
};

/**
 * Walk the entire settings object and replace any stale model IDs.
 * Uses JSON round-trip for simplicity since settings are plain data.
 */
function migrateModelIds<T>(obj: T): T {
  let json = JSON.stringify(obj);
  let changed = false;
  for (const [oldId, newId] of Object.entries(MODEL_ID_MIGRATIONS)) {
    if (oldId === newId) continue;
    if (json.includes(oldId)) {
      json = json.split(oldId).join(newId);
      changed = true;
    }
  }
  if (changed) {
    console.info('[Branch] Migrated stale model IDs in stored data');
    return JSON.parse(json);
  }
  return obj;
}

// --- Settings ---

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = migrateModelIds(JSON.parse(raw));
      const merged = { ...DEFAULT_SETTINGS, ...parsed };
      // Migrate old single critic → 3 specialized agents
      if (merged.roleAssignments?.critic && !merged.roleAssignments?.factChecker) {
        const oldCritic = merged.roleAssignments.critic;
        merged.roleAssignments.factChecker = { ...oldCritic };
        merged.roleAssignments.languageReviewer = { ...oldCritic };
        merged.roleAssignments.styleAuditor = { ...oldCritic };
        console.info('[Branch] Migrated single critic role → 3 specialized agents');
      }
      // Re-save so migrated values persist
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
      return merged;
    }
  } catch {
    console.warn('Failed to load settings from localStorage');
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    console.warn('Failed to save settings to localStorage');
  }
}

// --- Sessions ---

export function loadSessions(): CandidateSession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    console.warn('Failed to load sessions from localStorage');
  }
  return [];
}

export function saveSessions(sessions: CandidateSession[]): void {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  } catch {
    console.warn('Failed to save sessions to localStorage');
  }
}

export function saveSession(session: CandidateSession): void {
  const sessions = loadSessions();
  const idx = sessions.findIndex(s => s.id === session.id);
  if (idx >= 0) {
    sessions[idx] = session;
  } else {
    sessions.push(session);
  }
  saveSessions(sessions);
}

export function deleteSession(sessionId: string): void {
  const sessions = loadSessions().filter(s => s.id !== sessionId);
  saveSessions(sessions);
}

// --- Batch Queue ---

export function loadBatchQueue(): BatchQueueItem[] {
  try {
    const raw = localStorage.getItem(BATCH_QUEUE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    console.warn('Failed to load batch queue from localStorage');
  }
  return [];
}

export function saveBatchQueue(items: BatchQueueItem[]): void {
  try {
    localStorage.setItem(BATCH_QUEUE_KEY, JSON.stringify(items));
  } catch {
    console.warn('Failed to save batch queue to localStorage');
  }
}

// --- API Key helpers (basic obfuscation, NOT encryption) ---

export function maskApiKey(key: string): string {
  if (key.length <= 8) return '••••••••';
  return key.slice(0, 4) + '••••' + key.slice(-4);
}

// --- Encrypted API Key Storage ---

/**
 * Check if encrypted keys exist in localStorage.
 */
export function hasEncryptedKeys(): boolean {
  try {
    const raw = localStorage.getItem(ENCRYPTED_KEYS_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return isEncryptedPayload(parsed);
  } catch {
    return false;
  }
}

/**
 * Load the encrypted keys payload (for password verification).
 */
export function loadEncryptedKeysPayload(): EncryptedPayload | null {
  try {
    const raw = localStorage.getItem(ENCRYPTED_KEYS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isEncryptedPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Check if there are plain-text API keys in the old settings format.
 * Used to detect the migration case (first run after encryption was added).
 */
export function hasPlainTextApiKeys(): boolean {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    const keys = parsed.apiKeys;
    if (!keys || typeof keys !== 'object') return false;
    return Object.values(keys).some(v => typeof v === 'string' && (v as string).length > 0);
  } catch {
    return false;
  }
}

/**
 * Encrypt and save API keys.
 */
export async function saveEncryptedKeys(apiKeys: Record<string, string>, password: string): Promise<void> {
  const payload = await encrypt(JSON.stringify(apiKeys), password);
  localStorage.setItem(ENCRYPTED_KEYS_KEY, JSON.stringify(payload));

  // Remove plain-text keys from settings
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.apiKeys) {
        // Replace with empty object so settings still loads cleanly
        parsed.apiKeys = {};
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(parsed));
      }
    }
  } catch {
    // non-critical
  }
}

/**
 * Decrypt API keys with the given password.
 * Throws if the password is wrong (AES-GCM integrity check).
 */
export async function loadDecryptedKeys(password: string): Promise<Record<string, string>> {
  const raw = localStorage.getItem(ENCRYPTED_KEYS_KEY);
  if (!raw) return {};

  const payload: EncryptedPayload = JSON.parse(raw);
  const plaintext = await decrypt(payload, password);
  return JSON.parse(plaintext);
}

/**
 * Get API keys — tries session-cached password first, falls back to plain-text.
 * Returns empty object if locked (no password in session and keys are encrypted).
 */
export async function getApiKeys(): Promise<Record<string, string>> {
  // 1. Try decrypting with session-stored password
  const password = getStoredPassword();
  if (password && hasEncryptedKeys()) {
    try {
      return await loadDecryptedKeys(password);
    } catch {
      return {};
    }
  }

  // 2. Fall back to plain-text keys in settings (pre-migration)
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.apiKeys && typeof parsed.apiKeys === 'object') {
        const keys = parsed.apiKeys as Record<string, string>;
        if (Object.values(keys).some(v => v && v.length > 0)) {
          return keys;
        }
      }
    }
  } catch {
    // fall through
  }

  return {};
}

/**
 * Completely clear stored API keys from both plain settings and encrypted vault.
 */
export function clearStoredApiKeys(): void {
  try {
    localStorage.removeItem(ENCRYPTED_KEYS_KEY);
  } catch {
    // non-critical
  }

  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      parsed.apiKeys = {};
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(parsed));
    }
  } catch {
    // non-critical
  }
}
