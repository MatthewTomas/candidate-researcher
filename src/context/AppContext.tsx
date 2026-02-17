import React, { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import type { AppSettings, CandidateSession, AIProviderType, BatchQueueItem } from '../types';
import { DEFAULT_SETTINGS } from '../types';
import { rateLimiter } from '../services/rateLimiter';
import {
  loadSettings, saveSettings, loadSessions, saveSessions,
  saveSession as persistSession, deleteSession as removeSession,
  loadActiveSessionId, saveActiveSessionId,
  loadBatchQueue, saveBatchQueue,
  hasEncryptedKeys, hasPlainTextApiKeys, loadEncryptedKeysPayload,
  saveEncryptedKeys, loadDecryptedKeys, getApiKeys, clearStoredApiKeys,
} from '../services/storage';
import { createProvider, createTrackedProvider, type AIProvider, type TrackedProviderOptions } from '../services/aiProvider';
import { getCurrentMonthSpend } from '../services/costTracker';
import {
  storePassword, getStoredPassword, clearStoredPassword,
  verifyPassword,
} from '../services/crypto';
import { v4 as uuid } from 'uuid';

/**
 * Read API keys from environment variables (.env file, gitignored).
 * These act as seed defaults — keys entered in the Settings UI always override.
 * Vite only exposes variables prefixed with VITE_.
 */
function getEnvApiKeys(): Partial<Record<AIProviderType, string>> {
  const env = import.meta.env;
  const keys: Partial<Record<AIProviderType, string>> = {};
  if (env.VITE_GEMINI_API_KEY)      { keys['gemini-free'] = env.VITE_GEMINI_API_KEY; keys['gemini-paid'] = env.VITE_GEMINI_API_KEY; }
  if (env.VITE_ANTHROPIC_API_KEY)   keys.anthropic = env.VITE_ANTHROPIC_API_KEY;
  if (env.VITE_OPENAI_API_KEY)      keys.openai = env.VITE_OPENAI_API_KEY;
  if (env.VITE_XAI_API_KEY)         keys.xai = env.VITE_XAI_API_KEY;
  if (env.VITE_DEEPSEEK_API_KEY)    keys.deepseek = env.VITE_DEEPSEEK_API_KEY;
  if (env.VITE_HUGGINGFACE_API_KEY) keys.huggingface = env.VITE_HUGGINGFACE_API_KEY;
  if (env.VITE_QWEN_API_KEY)        keys.qwen = env.VITE_QWEN_API_KEY;
  if (env.VITE_MINIMAX_API_KEY)     keys.minimax = env.VITE_MINIMAX_API_KEY;
  return keys;
}

interface AppContextValue {
  // Settings
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  setApiKey: (provider: AIProviderType, key: string) => void;

  // Sessions
  sessions: CandidateSession[];
  activeSession: CandidateSession | null;
  setActiveSession: (session: CandidateSession | null) => void;
  createSession: (candidateName: string) => CandidateSession;
  updateSession: (session: CandidateSession) => void;
  removeSession: (id: string) => void;

  // Batch Queue
  batchQueue: BatchQueueItem[];
  setBatchQueue: React.Dispatch<React.SetStateAction<BatchQueueItem[]>>;
  addToQueue: (items: BatchQueueItem[]) => void;
  removeFromQueue: (ids: string[]) => void;
  updateQueueItem: (id: string, patch: Partial<BatchQueueItem>) => void;
  clearQueue: () => void;

  // AI Providers
  getProvider: (type: AIProviderType, model?: string) => Promise<AIProvider>;
  /** Get a provider wrapped with cost tracking */
  getTrackedProvider: (type: AIProviderType, opts: TrackedProviderOptions, model?: string) => Promise<AIProvider>;

  // Key vault (encryption)
  /** Whether the key vault is unlocked (password entered this session) */
  isUnlocked: boolean;
  /** Whether encrypted keys exist (need password on load) */
  needsUnlock: boolean;
  /** Whether plain-text keys need initial encryption (first-time setup) */
  needsEncryptionSetup: boolean;
  /** Unlock the vault with a password */
  unlockVault: (password: string) => Promise<boolean>;
  /** Set up encryption for the first time (encrypts existing plain-text keys) */
  setupEncryption: (password: string) => Promise<void>;
  /** Lock the vault (clears session password) */
  lockVault: () => void;
  /** Clear all API keys from memory and local storage (plain + encrypted) */
  clearAllApiKeys: () => void;

  // UI State
  toast: { message: string; type: 'success' | 'error' | 'info' } | null;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  dismissToast: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [sessions, setSessions] = useState<CandidateSession[]>([]);
  const [activeSession, setActiveSession] = useState<CandidateSession | null>(null);
  const [toast, setToast] = useState<AppContextValue['toast']>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [batchQueue, setBatchQueue] = useState<BatchQueueItem[]>([]);

  // Key vault state
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [needsUnlock, setNeedsUnlock] = useState(false);
  const [needsEncryptionSetup, setNeedsEncryptionSetup] = useState(false);

  // Load from localStorage on mount
  useEffect(() => {
    const loaded = loadSettings();

    // Seed with env-var keys first (lowest priority — localStorage & encrypted vault win)
    const envKeys = getEnvApiKeys();
    if (Object.keys(envKeys).length > 0) {
      // Only fill gaps: env vars never overwrite user-entered keys
      for (const [k, v] of Object.entries(envKeys)) {
        if (!loaded.apiKeys[k as AIProviderType]) {
          loaded.apiKeys[k as AIProviderType] = v;
        }
      }
    }

    setSettings(loaded);
    const loadedSessions = loadSessions();
    setSessions(loadedSessions);
    // Restore active session
    const savedId = loadActiveSessionId();
    if (savedId) {
      const found = loadedSessions.find(s => s.id === savedId);
      if (found) setActiveSession(found);
    }

    // Load batch queue
    setBatchQueue(loadBatchQueue());

    // Check encryption state
    const hasEncrypted = hasEncryptedKeys();

    // Sync Gemini tier with rate limiter
    rateLimiter.setGeminiTier(loaded.geminiTier ?? 'free');
    const hasPlain = hasPlainTextApiKeys();
    const sessionPw = getStoredPassword();

    if (hasEncrypted) {
      if (sessionPw) {
        // Auto-unlock with session-stored password
        loadDecryptedKeys(sessionPw).then(keys => {
          setSettings(prev => ({ ...prev, apiKeys: { ...prev.apiKeys, ...keys } }));
          setIsUnlocked(true);
        }).catch(() => {
          // Stored password is invalid (shouldn't happen, but handle it)
          clearStoredPassword();
          setNeedsUnlock(true);
        });
      } else {
        setNeedsUnlock(true);
      }
    } else if (hasPlain) {
      // Plain-text keys exist — prompt for encryption setup
      setNeedsEncryptionSetup(true);
      setIsUnlocked(true); // keys are readable, just not encrypted yet
    } else {
      // No keys at all — user is new or hasn't set any keys
      setIsUnlocked(true);
    }
  }, []);

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      // Sync Gemini tier with rate limiter when it changes
      if (patch.geminiTier !== undefined) {
        rateLimiter.setGeminiTier(patch.geminiTier);
      }
      return next;
    });
  }, []);

  const setApiKey = useCallback((provider: AIProviderType, key: string) => {
    setSettings(prev => {
      // Mirror Gemini keys: both gemini-free and gemini-paid share the same Google AI Studio key
      const isGemini = provider === 'gemini-free' || provider === 'gemini-paid';
      const updatedKeys = { ...prev.apiKeys, [provider]: key };
      if (isGemini) {
        updatedKeys['gemini-free'] = key;
        updatedKeys['gemini-paid'] = key;
      }
      const next = { ...prev, apiKeys: updatedKeys };
      // Save non-key settings
      saveSettings({ ...next, apiKeys: {} });
      // Save encrypted keys if we have a password
      const pw = getStoredPassword();
      if (pw) {
        saveEncryptedKeys(next.apiKeys, pw).catch(() => {
          // Fall back to plain-text if encryption fails
          saveSettings(next);
        });
      } else {
        saveSettings(next);
      }
      return next;
    });
  }, []);

  // ── Batch Queue ──
  const addToQueue = useCallback((newItems: BatchQueueItem[]) => {
    setBatchQueue(prev => {
      const next = [...prev, ...newItems];
      saveBatchQueue(next);
      return next;
    });
  }, []);

  const removeFromQueue = useCallback((ids: string[]) => {
    const idSet = new Set(ids);
    setBatchQueue(prev => {
      const next = prev.filter(i => !idSet.has(i.id));
      saveBatchQueue(next);
      return next;
    });
  }, []);

  const updateQueueItem = useCallback((id: string, patch: Partial<BatchQueueItem>) => {
    setBatchQueue(prev => {
      const next = prev.map(i => i.id === id ? { ...i, ...patch } : i);
      saveBatchQueue(next);
      return next;
    });
  }, []);

  const clearQueue = useCallback(() => {
    setBatchQueue([]);
    saveBatchQueue([]);
  }, []);

  // Persist queue on external setBatchQueue calls
  useEffect(() => {
    // This effect syncs queue changes from setBatchQueue calls
    // that don't go through add/remove/update helpers
    saveBatchQueue(batchQueue);
  }, [batchQueue]);

  const createSession = useCallback((candidateName: string): CandidateSession => {
    const session: CandidateSession = {
      id: uuid(),
      candidateName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentDraft: null,
      builderRounds: [],
      auditReports: [],
      importedHtml: null,
      extractedProfile: null,
      additionalSources: [],
      status: 'importing',
    };
    setSessions(prev => {
      const next = [...prev, session];
      saveSessions(next);
      return next;
    });
    setActiveSession(session);
    return session;
  }, []);

  const updateSession = useCallback((session: CandidateSession) => {
    session.updatedAt = new Date().toISOString();
    setSessions(prev => {
      const next = prev.map(s => s.id === session.id ? session : s);
      saveSessions(next);
      return next;
    });
    setActiveSession(prev => {
      if (prev?.id === session.id) {
        saveActiveSessionId(session.id);
        return session;
      }
      return prev;
    });
    persistSession(session);
  }, []);

  const deleteSession = useCallback((id: string) => {
    setSessions(prev => {
      const next = prev.filter(s => s.id !== id);
      saveSessions(next);
      return next;
    });
    setActiveSession(prev => {
      if (prev?.id === id) {
        saveActiveSessionId(null);
        return null;
      }
      return prev;
    });
    removeSession(id);
  }, []);

  const getProvider = useCallback(async (type: AIProviderType, model?: string): Promise<AIProvider> => {
    const apiKey = settings.apiKeys[type];
    if (!apiKey) throw new Error(`No API key configured for ${type}. Go to Settings to add one.`);

    // Spending cap check — $0 means unlimited
    if (settings.spendingCapUsd > 0) {
      const currentSpend = getCurrentMonthSpend();
      if (currentSpend >= settings.spendingCapUsd) {
        throw new Error(
          `Monthly spending cap reached ($${currentSpend.toFixed(2)} / $${settings.spendingCapUsd.toFixed(2)}). ` +
          `Increase your cap in Settings or switch to free-tier models.`
        );
      }
    }

    return createProvider(type, apiKey, model);
  }, [settings.apiKeys, settings.spendingCapUsd]);

  const getTrackedProvider = useCallback(async (type: AIProviderType, opts: TrackedProviderOptions, model?: string): Promise<AIProvider> => {
    const apiKey = settings.apiKeys[type];
    if (!apiKey) throw new Error(`No API key configured for ${type}. Go to Settings to add one.`);

    // Spending cap check — $0 means unlimited
    if (settings.spendingCapUsd > 0) {
      const currentSpend = getCurrentMonthSpend();
      if (currentSpend >= settings.spendingCapUsd) {
        throw new Error(
          `Monthly spending cap reached ($${currentSpend.toFixed(2)} / $${settings.spendingCapUsd.toFixed(2)}). ` +
          `Increase your cap in Settings or switch to free-tier models.`
        );
      }
    }

    return createTrackedProvider(type, apiKey, opts, model);
  }, [settings.apiKeys, settings.spendingCapUsd]);

  const showToast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
    // Clear any existing timeout to prevent stacking
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    setToast({ message, type });
    toastTimeoutRef.current = setTimeout(() => {
      setToast(null);
      toastTimeoutRef.current = null;
    }, 5000);
  }, []);

  const dismissToast = useCallback(() => {
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = null;
    setToast(null);
  }, []);

  // --- Key vault methods ---

  const unlockVault = useCallback(async (password: string): Promise<boolean> => {
    const payload = loadEncryptedKeysPayload();
    if (!payload) return false;
    const valid = await verifyPassword(payload, password);
    if (!valid) return false;

    storePassword(password);
    const keys = await loadDecryptedKeys(password);
    setSettings(prev => ({ ...prev, apiKeys: { ...prev.apiKeys, ...keys } }));
    setIsUnlocked(true);
    setNeedsUnlock(false);
    return true;
  }, []);

  const setupEncryption = useCallback(async (password: string): Promise<void> => {
    // Encrypt current plain-text keys
    const currentKeys = settings.apiKeys;
    await saveEncryptedKeys(currentKeys, password);
    storePassword(password);
    setIsUnlocked(true);
    setNeedsEncryptionSetup(false);
  }, [settings.apiKeys]);

  const lockVault = useCallback(() => {
    clearStoredPassword();
    // Clear API keys from in-memory settings
    setSettings(prev => ({ ...prev, apiKeys: {} }));
    setIsUnlocked(false);
    setNeedsUnlock(true);
  }, []);

  const clearAllApiKeys = useCallback(() => {
    clearStoredPassword();
    clearStoredApiKeys();
    setSettings(prev => {
      const next = { ...prev, apiKeys: {} };
      saveSettings(next);
      return next;
    });
    setIsUnlocked(true);
    setNeedsUnlock(false);
    setNeedsEncryptionSetup(false);
  }, []);

  return (
    <AppContext.Provider value={{
      settings, updateSettings, setApiKey,
      sessions, activeSession,
      batchQueue, setBatchQueue, addToQueue, removeFromQueue, updateQueueItem, clearQueue,
      setActiveSession: useCallback((session: CandidateSession | null) => {
        setActiveSession(session);
        saveActiveSessionId(session?.id ?? null);
      }, []),
      createSession, updateSession, removeSession: deleteSession,
      getProvider, getTrackedProvider,
      isUnlocked, needsUnlock, needsEncryptionSetup,
      unlockVault, setupEncryption, lockVault, clearAllApiKeys,
      toast, showToast, dismissToast,
    }}>
      {children}
    </AppContext.Provider>
  );
}
