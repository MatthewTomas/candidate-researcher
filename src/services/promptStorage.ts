/**
 * Prompt storage — lets users permanently override the system prompts
 * used by each agent. Overrides are stored in localStorage.
 * Falls back to the compiled-in default when not set.
 */

const STORAGE_KEY = 'branch_playground_custom_prompts_v1';

type PromptRole =
  | 'writer'
  | 'critic'
  | 'fact-checker'
  | 'language-reviewer'
  | 'style-auditor'
  | 'extractor'
  | 'verifier';

type PromptStore = Partial<Record<PromptRole, string>>;

function load(): PromptStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PromptStore) : {};
  } catch {
    return {};
  }
}

function save(store: PromptStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // quota exceeded — ignore
  }
}

/** Returns the custom prompt for this role, or null if the default should be used. */
export function getCustomPrompt(role: PromptRole): string | null {
  const store = load();
  return store[role] ?? null;
}

/** Permanently saves a custom prompt for this role. */
export function saveCustomPrompt(role: PromptRole, prompt: string): void {
  const store = load();
  store[role] = prompt;
  save(store);
}

/** Removes any custom override for this role, restoring the default. */
export function clearCustomPrompt(role: PromptRole): void {
  const store = load();
  delete store[role];
  save(store);
}

/** Returns true if there is a saved override for this role. */
export function hasCustomPrompt(role: PromptRole): boolean {
  return getCustomPrompt(role) !== null;
}
