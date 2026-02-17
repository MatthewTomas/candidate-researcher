import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { Spinner } from './shared';

/**
 * Modal gate that appears when encrypted API keys need unlocking.
 * Also handles first-time encryption setup (migrating plain-text keys).
 */
export function UnlockGate({ children }: { children: React.ReactNode }) {
  const { needsUnlock, needsEncryptionSetup, isUnlocked, unlockVault, setupEncryption } = useApp();

  if (isUnlocked && !needsEncryptionSetup) return <>{children}</>;

  if (needsEncryptionSetup) {
    return <SetupEncryptionDialog onComplete={setupEncryption} />;
  }

  if (needsUnlock) {
    return <UnlockDialog onUnlock={unlockVault} />;
  }

  return <>{children}</>;
}

function UnlockDialog({ onUnlock }: { onUnlock: (pw: string) => Promise<boolean> }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    setLoading(true);
    setError('');

    const ok = await onUnlock(password);
    if (!ok) {
      setError('Incorrect password. Please try again.');
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl border border-gray-200 max-w-md w-full p-8">
        <div className="text-center mb-6">
          <div className="h-12 w-12 rounded-xl bg-branch-600 flex items-center justify-center mx-auto mb-3">
            <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-gray-900">Unlock Branch Playground</h2>
          <p className="text-sm text-gray-500 mt-1">
            Enter your encryption password to decrypt API keys.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="unlock-pw" className="block text-sm font-medium text-gray-700 mb-1">
              Password
            </label>
            <input
              id="unlock-pw"
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-branch-500 focus:border-branch-500"
              placeholder="Enter encryption password"
            />
          </div>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || !password.trim()}
            className="w-full btn-primary py-2 flex items-center justify-center gap-2"
          >
            {loading ? <><Spinner size="sm" /> Decrypting…</> : 'Unlock'}
          </button>
        </form>

        <p className="text-xs text-gray-400 text-center mt-4">
          Keys are encrypted with AES-256-GCM. The password is held in session memory only and is cleared when you close this tab.
        </p>
      </div>
    </div>
  );
}

function SetupEncryptionDialog({ onComplete }: { onComplete: (pw: string) => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [skipped, setSkipped] = useState(false);

  if (skipped) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    setError('');

    try {
      await onComplete(password);
    } catch {
      setError('Encryption failed. Please try again.');
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl border border-gray-200 max-w-md w-full p-8">
        <div className="text-center mb-6">
          <div className="h-12 w-12 rounded-xl bg-amber-500 flex items-center justify-center mx-auto mb-3">
            <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-gray-900">Encrypt Your API Keys</h2>
          <p className="text-sm text-gray-500 mt-1">
            Your API keys are currently stored as plain text in localStorage.
            Set a password to encrypt them at rest with AES-256-GCM.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="setup-pw" className="block text-sm font-medium text-gray-700 mb-1">
              New Password
            </label>
            <input
              id="setup-pw"
              type="password"
              autoFocus
              autoComplete="new-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-branch-500 focus:border-branch-500"
              placeholder="At least 6 characters"
            />
          </div>

          <div>
            <label htmlFor="setup-pw-confirm" className="block text-sm font-medium text-gray-700 mb-1">
              Confirm Password
            </label>
            <input
              id="setup-pw-confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-branch-500 focus:border-branch-500"
              placeholder="Re-enter password"
            />
          </div>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || !password.trim() || !confirm.trim()}
            className="w-full btn-primary py-2 flex items-center justify-center gap-2"
          >
            {loading ? <><Spinner size="sm" /> Encrypting…</> : 'Encrypt & Continue'}
          </button>

          <button
            type="button"
            onClick={() => setSkipped(true)}
            className="w-full text-xs text-gray-400 hover:text-gray-600 py-1"
          >
            Skip for now (keys remain unencrypted)
          </button>
        </form>

        <p className="text-xs text-gray-400 text-center mt-4">
          You'll enter this password once each time you open a new tab.
          If you forget it, you can re-enter your API keys in Settings.
        </p>
      </div>
    </div>
  );
}
