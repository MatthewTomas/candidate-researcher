/**
 * AES-GCM encryption service for API key storage at rest.
 *
 * Flow:
 *  1. User enters a password once per tab (on first load).
 *  2. Password → PBKDF2 → AES-GCM-256 CryptoKey (stored in sessionStorage for the tab lifetime).
 *  3. API keys encrypted before writing to localStorage, decrypted on read.
 *  4. Closing the tab clears the CryptoKey — next visit requires the password again.
 *
 * Data format stored in localStorage:
 *   { salt: base64, iv: base64, ciphertext: base64 }
 */

const SESSION_CRYPTO_KEY = 'branch_playground_crypto_key';
const PBKDF2_ITERATIONS = 600_000;

// ─── Key Derivation ───────────────────────────────────

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,          // not extractable
    ['encrypt', 'decrypt'],
  );
}

// ─── Encrypt / Decrypt ────────────────────────────────

export interface EncryptedPayload {
  salt: string;      // base64
  iv: string;        // base64
  ciphertext: string; // base64
}

function bufToBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function base64ToBuf(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

/**
 * Encrypt plaintext with a password-derived key.
 */
export async function encrypt(plaintext: string, password: string): Promise<EncryptedPayload> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const key  = await deriveKey(password, salt);
  const enc  = new TextEncoder();

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(plaintext),
  );

  return {
    salt: bufToBase64(salt),
    iv: bufToBase64(iv),
    ciphertext: bufToBase64(ciphertext),
  };
}

/**
 * Decrypt an EncryptedPayload back to plaintext.
 * Throws on wrong password (integrity check failure).
 */
export async function decrypt(payload: EncryptedPayload, password: string): Promise<string> {
  const salt = base64ToBuf(payload.salt);
  const iv   = base64ToBuf(payload.iv);
  const data = base64ToBuf(payload.ciphertext);
  const key  = await deriveKey(password, salt);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    data,
  );

  return new TextDecoder().decode(decrypted);
}

// ─── Session-scoped password management ───────────────

/**
 * Store the password hash in sessionStorage so the user only enters it once per tab.
 * We store the raw password (not the key) because we need it to derive fresh keys
 * with different salts for each encrypt call.
 *
 * NOTE: This is stored in sessionStorage which is tab-scoped and cleared on tab close.
 * It's more secure than localStorage but still accessible to JS on the same origin.
 * This is an acceptable tradeoff for a local dev tool.
 */
export function storePassword(password: string): void {
  sessionStorage.setItem(SESSION_CRYPTO_KEY, password);
}

export function getStoredPassword(): string | null {
  return sessionStorage.getItem(SESSION_CRYPTO_KEY);
}

export function clearStoredPassword(): void {
  sessionStorage.removeItem(SESSION_CRYPTO_KEY);
}

/**
 * Check if given password can decrypt the payload (used for validation).
 */
export async function verifyPassword(payload: EncryptedPayload, password: string): Promise<boolean> {
  try {
    await decrypt(payload, password);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks whether a value looks like an EncryptedPayload (vs plain-text keys).
 */
export function isEncryptedPayload(value: unknown): value is EncryptedPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'salt' in value &&
    'iv' in value &&
    'ciphertext' in value
  );
}
