import React, { useState, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import {
  AI_PROVIDERS,
  GEMINI_TIER_INFO,
  type AIProviderType,
  type AppSettings,
  type CriticRunCounts,
  type CriticParallelism,
  type GeminiTier,
} from '../types';
import { Spinner, StatusBadge, ConfirmDialog } from '../components/shared';
import { ModelPicker, CostBadge } from '../components/ModelPicker';
import CostCalculator from '../components/CostCalculator';
import CostDashboard from '../components/CostDashboard';
import { getCustomPrompt, saveCustomPrompt, clearCustomPrompt } from '../services/promptStorage';
import { WRITER_SYSTEM_PROMPT } from '../services/agents/writer';
import { FACT_CHECKER_SYSTEM_PROMPT } from '../services/agents/factChecker';
import { LANGUAGE_REVIEWER_SYSTEM_PROMPT } from '../services/agents/languageReviewer';
import { STYLE_AUDITOR_SYSTEM_PROMPT } from '../services/agents/styleAuditor';

// ── All providers, alphabetized. Gemini appears once (gemini-paid hidden). ──
const PROVIDER_ENTRIES = Object.entries(AI_PROVIDERS) as [AIProviderType, typeof AI_PROVIDERS[AIProviderType]][];
const ALL_PROVIDERS = PROVIDER_ENTRIES
  .filter(([t]) => t !== 'gemini-paid')          // Gemini = single entry via gemini-free
  .map(([t, info]) => ({
    type: t as AIProviderType,
    info,
    sortName: t === 'gemini-free' ? 'Google Gemini' : info.name,
    isGemini: t === 'gemini-free',
  }))
  .sort((a, b) => a.sortName.localeCompare(b.sortName));

const ROLES = [
  { key: 'writer', label: 'Writer Agent', desc: 'Generates the candidate profile', promptRole: 'writer' as PromptRole, promptDefault: WRITER_SYSTEM_PROMPT },
] as const;

const CRITIC_AGENTS = [
  { key: 'factChecker', label: 'Fact Checker', emoji: '🔬', desc: 'Verifies factual accuracy, sources, identity matching, and unsupported claims', rcKey: 'factChecker' as keyof CriticRunCounts, promptRole: 'fact-checker' as PromptRole, promptDefault: FACT_CHECKER_SYSTEM_PROMPT },
  { key: 'languageReviewer', label: 'Language Reviewer', emoji: '📝', desc: 'Checks for biased and partisan language using the substitution chart', rcKey: 'languageReviewer' as keyof CriticRunCounts, promptRole: 'language-reviewer' as PromptRole, promptDefault: LANGUAGE_REVIEWER_SYSTEM_PROMPT },
  { key: 'styleAuditor', label: 'Style & Template Auditor', emoji: '📐', desc: 'Enforces formatting rules — name usage, degree casing, stance unbundling, etc.', rcKey: 'styleAuditor' as keyof CriticRunCounts, promptRole: 'style-auditor' as PromptRole, promptDefault: STYLE_AUDITOR_SYSTEM_PROMPT },
] as const;

const TOC = [
  { id: 'providers', label: 'AI Providers', icon: '🔑' },
  { id: 'cost', label: 'Cost & Spending', icon: '💰' },
  { id: 'pipeline', label: 'Pipeline & Roles', icon: '🔧' },
  { id: 'data', label: 'Sessions', icon: '💾' },
] as const;

/* ═══════════════════════════ CollapsibleSection (outer card) ═══════════════ */
function CollapsibleSection({
  id, title, subtitle, badge, badgeColor, defaultOpen = false, children,
}: {
  id: string;
  title: string;
  subtitle?: string;
  badge?: string;
  badgeColor?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section id={id} className="card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between p-5 text-left hover:bg-gray-50/50 transition-colors"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-gray-800">{title}</h3>
            {badge && (
              <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${badgeColor || 'bg-gray-100 text-gray-600'}`}>
                {badge}
              </span>
            )}
          </div>
          {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
        </div>
        <svg
          className={`h-5 w-5 text-gray-400 transition-transform flex-shrink-0 ml-3 ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && <div className="px-5 pb-5 space-y-4 border-t border-gray-100 pt-4">{children}</div>}
    </section>
  );
}

/* ═══════════════════════ SubCollapsible (nested, no card) ══════════════════ */
function SubCollapsible({
  title, subtitle, badge, badgeColor, defaultOpen = false, children,
}: {
  title: string;
  subtitle?: string;
  badge?: string;
  badgeColor?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-gray-100 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3.5 py-2.5 text-left hover:bg-gray-50/50 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-gray-700">{title}</span>
          {badge && (
            <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${badgeColor || 'bg-gray-100 text-gray-600'}`}>
              {badge}
            </span>
          )}
          {subtitle && <span className="text-xs text-gray-400 truncate hidden sm:inline">{subtitle}</span>}
        </div>
        <svg
          className={`h-4 w-4 text-gray-300 transition-transform flex-shrink-0 ml-2 ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && <div className="px-3.5 pb-3.5 space-y-3 border-t border-gray-100 pt-3">{children}</div>}
    </div>
  );
}

/* ═══════════════════════════ Eye Icon ═══════════════════════════════════ */
function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
    </svg>
  ) : (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
    </svg>
  );
}

/* ═══════════════════════════ PromptEditor ════════════════════════════════ */
type PromptRole = 'writer' | 'critic' | 'fact-checker' | 'language-reviewer' | 'style-auditor';

function PromptEditor({ role, label, emoji, defaultPrompt }: {
  role: PromptRole;
  label: string;
  emoji: string;
  defaultPrompt: string;
}) {
  const saved = getCustomPrompt(role);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(saved ?? defaultPrompt);
  const [dirty, setDirty] = useState(false);
  const isCustom = saved !== null;

  const handleChange = (v: string) => { setText(v); setDirty(v !== (saved ?? defaultPrompt)); };
  const handleSave = () => { saveCustomPrompt(role, text); setDirty(false); };
  const handleRestore = () => { clearCustomPrompt(role); setText(defaultPrompt); setDirty(false); };

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-2.5 bg-white hover:bg-gray-50 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <span>{emoji}</span>
          <span className="text-xs font-semibold text-gray-700">{label}</span>
          {isCustom && (
            <span className="text-sm font-bold px-1.5 py-0.5 rounded-full bg-branch-100 text-branch-700">CUSTOM</span>
          )}
        </div>
        <svg className={`h-4 w-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="border-t border-gray-100 p-3 space-y-2 bg-gray-50/40">
          <textarea
            rows={10}
            className="w-full text-sm font-mono border border-gray-200 rounded-lg p-2 bg-white resize-y focus:outline-none focus:ring-2 focus:ring-branch-400"
            value={text}
            onChange={e => handleChange(e.target.value)}
          />
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={handleRestore}
              disabled={!isCustom}
              className="text-sm text-gray-400 hover:text-gray-600 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Restore Default
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty}
              className="text-sm font-semibold px-3 py-1.5 rounded-lg bg-branch-600 text-white hover:bg-branch-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Save Prompt
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════ MAIN PAGE ═══════════════════════════════════ */
export default function SettingsPage() {
  const { settings, updateSettings, setApiKey, sessions, removeSession, showToast, clearAllApiKeys } = useApp();
  const [testingProvider, setTestingProvider] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, 'success' | 'error'>>({});
  const [deletingSession, setDeletingSession] = useState<string | null>(null);
  const [showKeyValues, setShowKeyValues] = useState<Record<string, boolean>>({});
  const [confirmClearKeys, setConfirmClearKeys] = useState(false);
  const [showGoogleKey, setShowGoogleKey] = useState(false);
  const [showGoogleCx, setShowGoogleCx] = useState(false);
  const [testingGoogle, setTestingGoogle] = useState(false);
  const [googleTestResult, setGoogleTestResult] = useState<'success' | 'error' | null>(null);

  // ── Test API key ──
  const handleTest = useCallback(async (providerType: AIProviderType) => {
    const key = settings.apiKeys[providerType];
    if (!key) { showToast(`No API key for ${providerType}`, 'error'); return; }
    setTestingProvider(providerType);
    try {
      const { createProvider } = await import('../services/aiProvider');
      const provider = await createProvider(providerType, key);
      const isValid = await provider.testConnection();
      if (!isValid) {
        setTestResults(p => ({ ...p, [providerType]: 'error' }));
        showToast(`${AI_PROVIDERS[providerType].name}: connection test failed — key may be invalid`, 'error');
        return;
      }
      setTestResults(p => ({ ...p, [providerType]: 'success' }));
      showToast(`${AI_PROVIDERS[providerType].name} connected!`, 'success');
    } catch (err: any) {
      setTestResults(p => ({ ...p, [providerType]: 'error' }));
      showToast(`${AI_PROVIDERS[providerType].name}: ${err.message}`, 'error');
    } finally {
      setTestingProvider(null);
    }
  }, [settings.apiKeys, showToast]);

  // ── Test Google CSE ──
  const handleTestGoogle = useCallback(async () => {
    const key = settings.googleSearchApiKey;
    const cx = settings.googleSearchEngineId;
    if (!key || !cx) { showToast('Enter both API key and Search Engine ID first', 'error'); return; }
    setTestingGoogle(true);
    setGoogleTestResult(null);
    try {
      const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}&q=test&num=1`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg = body?.error?.message || `HTTP ${res.status}`;
        setGoogleTestResult('error');
        showToast(`Google CSE: ${msg}`, 'error');
        return;
      }
      setGoogleTestResult('success');
      showToast('Google Custom Search connected!', 'success');
    } catch (err: any) {
      setGoogleTestResult('error');
      showToast(`Google CSE: ${err.message}`, 'error');
    } finally {
      setTestingGoogle(false);
    }
  }, [settings.googleSearchApiKey, settings.googleSearchEngineId, showToast]);

  // ── Role helpers ──
  const setRole = (role: string, provider: AIProviderType, model?: string) => {
    updateSettings({
      roleAssignments: { ...settings.roleAssignments, [role]: { provider, model: model || AI_PROVIDERS[provider].defaultModel } },
    });
  };
  const setRoleModel = (role: string, model: string) => {
    const cur = settings.roleAssignments?.[role as keyof typeof settings.roleAssignments] as { provider: AIProviderType; model?: string } | undefined;
    if (!cur) return;
    updateSettings({ roleAssignments: { ...settings.roleAssignments, [role]: { ...cur, model } } });
  };
  const setVerifiers = (v: { provider: AIProviderType; model?: string }[]) => {
    updateSettings({ roleAssignments: { ...settings.roleAssignments, verifiers: v } });
  };

  const currentVerifiers = settings.roleAssignments?.verifiers || [{ provider: 'gemini-free' as AIProviderType }];
  const currentMonth = new Date().toISOString().slice(0, 7);
  const displaySpend = settings.spendingMonth === currentMonth ? settings.currentMonthSpendUsd : 0;
  const geminiKey = settings.apiKeys['gemini-free'] || settings.apiKeys['gemini-paid'] || '';
  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Count configured keys for badge
  const configuredCount = ALL_PROVIDERS.filter(p =>
    p.isGemini ? !!geminiKey : !!settings.apiKeys[p.type]
  ).length;

  return (
    <div className="flex gap-6 max-w-6xl">
      {/* ═══ LEFT COLUMN — scrollable settings ═══ */}
      <div className="flex-1 min-w-0 space-y-4">
      {/* ── Header ── */}
      <div>
        <h2 className="text-xl font-bold text-gray-900">Settings</h2>
        <p className="text-sm text-gray-500">Configure AI providers, pipeline strategy, and cost tracking</p>
      </div>

      {/* ── Quick nav ── */}
      <div className="flex items-center gap-2 flex-wrap">
        {TOC.map(s => (
          <button key={s.id} onClick={() => scrollTo(s.id)} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600 hover:bg-branch-50 hover:text-branch-700 transition-colors">
            <span>{s.icon}</span><span>{s.label}</span>
          </button>
        ))}
      </div>

      {/* ── API key safety banner ── */}
      <div className="rounded-lg bg-blue-50 border border-blue-200 px-4 py-3">
        <details className="text-sm text-blue-800">
          <summary className="cursor-pointer font-semibold text-blue-900 flex items-center gap-2">
            <svg className="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
            Your API Keys Are Safe — Click for details
          </summary>
          <ul className="mt-2 space-y-1.5 ml-6 text-xs">
            <li>• Keys are stored <strong>only</strong> in your browser's <code className="bg-blue-100 px-1 rounded text-xs">localStorage</code>.</li>
            <li>• This app runs <strong>100% client-side</strong>. No server. API calls go directly to providers.</li>
            <li>• Each provider has a <strong>help link</strong> for key management and spending limits.</li>
            <li>• <strong>Pricing sources:</strong> Official provider pricing pages, last verified Feb 2026.</li>
          </ul>
        </details>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          §1  AI PROVIDERS — unified, alphabetized, each individually collapsible
          ══════════════════════════════════════════════════════════════════════ */}
      <CollapsibleSection
        id="providers"
        title="AI Providers"
        subtitle="API keys, billing tiers, and available models"
        badge={`${configuredCount}/${ALL_PROVIDERS.length} configured`}
        badgeColor={configuredCount === ALL_PROVIDERS.length ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}
        defaultOpen
      >
        {ALL_PROVIDERS.map(({ type, info, sortName, isGemini }) =>
          isGemini ? (
            /* ─── Google Gemini (unified key + tier) ───────────────────── */
            <SubCollapsible
              key="gemini"
              title="Google Gemini"
              badge={testResults['gemini-free'] === 'error' ? 'ERROR' : geminiKey ? 'CONFIGURED' : 'NOT SET'}
              badgeColor={
                testResults['gemini-free'] === 'error'
                  ? 'bg-red-100 text-red-700'
                  : geminiKey
                    ? 'bg-green-100 text-green-700'
                    : 'bg-gray-200 text-gray-500'
              }
              subtitle="Free & Paid models"
              defaultOpen={!geminiKey}
            >
              {/* API key */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-gray-600">API Key</span>
                  <span className="text-xs text-gray-400">(shared between Free & Paid tiers)</span>
                </div>
                <div className="flex items-end gap-2">
                  <div className="flex-1 relative">
                    <input
                      type={showKeyValues['gemini'] ? 'text' : 'password'}
                      className="input text-sm font-mono pr-8"
                      placeholder="Enter Google AI Studio API key…"
                      autoComplete="off"
                      data-1p-ignore
                      data-lpignore="true"
                      value={geminiKey}
                      onChange={e => setApiKey('gemini-free', e.target.value)}
                      onPaste={e => { e.stopPropagation(); const t = e.clipboardData.getData('text/plain'); if (t) { e.preventDefault(); setApiKey('gemini-free', t); } }}
                    />
                    <button onClick={() => setShowKeyValues(p => ({ ...p, gemini: !p.gemini }))} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600" title={showKeyValues['gemini'] ? 'Hide' : 'Show'}>
                      <EyeIcon open={!!showKeyValues['gemini']} />
                    </button>
                  </div>
                  <button className="btn-secondary text-xs py-2" onClick={() => handleTest('gemini-free')} disabled={!geminiKey || testingProvider === 'gemini-free'}>
                    {testingProvider === 'gemini-free' ? <Spinner size="sm" /> : 'Test'}
                  </button>
                  {testResults['gemini-free'] && <StatusBadge status={testResults['gemini-free'] === 'success' ? 'verified' : 'error'} />}
                </div>
                <div className="flex items-center justify-between text-xs">
                  <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="text-branch-600 hover:underline font-medium">Get API key →</a>
                  <span className="text-gray-400">One key works for both Free and Paid tiers.</span>
                </div>
              </div>

              {/* Rate limit info */}
              <div className="space-y-2 border-t border-gray-100 pt-3">
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                  <div className="flex items-start gap-2">
                    <span className="text-amber-500 text-sm mt-0.5">ℹ️</span>
                    <div className="text-sm text-amber-800 space-y-1">
                      <p className="font-semibold">Rate limits are determined by your Google AI Studio billing setup.</p>
                      <p>The app automatically handles rate limiting. If you hit rate limits, requests are queued and retried with backoff.</p>
                      <p className="mt-1">
                        <a href="https://aistudio.google.com/usage?timeRange=last-28-days&tab=rate-limit" target="_blank" rel="noopener noreferrer" className="underline font-semibold text-amber-900">
                          Check your tier & limits in AI Studio →
                        </a>
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Gemini Tier selector */}
              <div className="space-y-2 border-t border-gray-100 pt-3">
                <label className="text-xs font-semibold text-gray-600">Your Gemini Billing Tier</label>
                <p className="text-xs text-gray-400">Select the tier matching your Google AI Studio billing setup. This controls cost tracking accuracy.</p>
                <div className="grid grid-cols-2 gap-2">
                  {(Object.entries(GEMINI_TIER_INFO) as [GeminiTier, typeof GEMINI_TIER_INFO[GeminiTier]][]).map(([tier, info]) => (
                    <label key={tier} className={`cursor-pointer rounded-lg border-2 p-2.5 transition-all ${
                      (settings.geminiTier || 'free') === tier
                        ? 'border-blue-400 bg-blue-50 shadow-sm'
                        : 'border-gray-200 bg-white hover:border-gray-300'
                    }`}>
                      <input type="radio" name="geminiTier" className="sr-only" checked={(settings.geminiTier || 'free') === tier} onChange={() => updateSettings({ geminiTier: tier })} />
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-xs font-semibold text-gray-800">{info.label}</span>
                        {info.chargesPerToken
                          ? <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">💰 Billed</span>
                          : <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-green-100 text-green-700">Free</span>
                        }
                      </div>
                      <p className="text-xs text-gray-500">{info.description}</p>
                      <p className="text-xs text-gray-400 mt-0.5">~{info.estimatedRpm} RPM · {info.estimatedRpd.toLocaleString()} RPD</p>
                    </label>
                  ))}
                </div>
                {(settings.geminiTier || 'free') !== 'free' && (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5">
                    <p className="text-xs text-amber-800">
                      <strong>Paid tier selected.</strong> API calls to Gemini will be tracked as paid usage. Pipeline roles assigned to "Gemini Free" will automatically use paid-tier pricing.
                    </p>
                  </div>
                )}
              </div>

              {/* Models */}
              <div className="border-t border-gray-100 pt-2">
                <details>
                  <summary className="cursor-pointer text-xs font-medium text-gray-500 hover:underline">
                    Models ({AI_PROVIDERS['gemini-free'].models.length} free + {AI_PROVIDERS['gemini-paid'].models.length} paid)
                  </summary>
                  <div className="mt-2 space-y-2">
                    <div>
                      <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Free Tier</span>
                      <div className="flex flex-wrap gap-1 mt-0.5">
                        {AI_PROVIDERS['gemini-free'].models.map(m => (
                          <span key={m.id} className="inline-flex items-center gap-1 bg-gray-50 border border-gray-100 rounded px-1.5 py-0.5 text-xs">
                            <span className="text-gray-600">{m.name}</span><CostBadge costTier={m.costTier} />
                          </span>
                        ))}
                      </div>
                    </div>
                    <div>
                      <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Paid Tier</span>
                      <div className="flex flex-wrap gap-1 mt-0.5">
                        {AI_PROVIDERS['gemini-paid'].models.map(m => (
                          <span key={m.id} className="inline-flex items-center gap-1 bg-gray-50 border border-gray-100 rounded px-1.5 py-0.5 text-xs">
                            <span className="text-gray-600">{m.name}</span><CostBadge costTier={m.costTier} />
                            {m.costPerMillionTokens != null && <span className="text-gray-400">${m.costPerMillionTokens}/${m.outputCostPerMillionTokens}</span>}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </details>
              </div>
            </SubCollapsible>
          ) : (
            /* ─── Standard provider ────────────────────────────────── */
            <SubCollapsible
              key={type}
              title={info.name}
              badge={testResults[type] === 'error' ? 'ERROR' : settings.apiKeys[type] ? 'CONFIGURED' : 'NOT SET'}
              badgeColor={
                testResults[type] === 'error'
                  ? 'bg-red-100 text-red-700'
                  : settings.apiKeys[type]
                    ? 'bg-green-100 text-green-700'
                    : 'bg-gray-200 text-gray-500'
              }
              subtitle={info.description}
              defaultOpen={false}
            >
              <p className="text-xs text-gray-400">{info.description}</p>

              <div className="flex items-end gap-2">
                <div className="flex-1 relative">
                  <input
                    type={showKeyValues[type] ? 'text' : 'password'}
                    className="input text-sm font-mono pr-8"
                    placeholder={`Enter ${info.name} API key…`}
                    autoComplete="off"
                    data-1p-ignore
                    data-lpignore="true"
                    value={settings.apiKeys[type] || ''}
                    onChange={e => setApiKey(type, e.target.value)}
                    onPaste={e => { e.stopPropagation(); const t = e.clipboardData.getData('text/plain'); if (t) { e.preventDefault(); setApiKey(type, t); } }}
                  />
                  <button onClick={() => setShowKeyValues(p => ({ ...p, [type]: !p[type] }))} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600" title={showKeyValues[type] ? 'Hide' : 'Show'}>
                    <EyeIcon open={!!showKeyValues[type]} />
                  </button>
                </div>
                <button className="btn-secondary text-xs py-2" onClick={() => handleTest(type)} disabled={!settings.apiKeys[type] || testingProvider === type}>
                  {testingProvider === type ? <Spinner size="sm" /> : 'Test'}
                </button>
                {testResults[type] && <StatusBadge status={testResults[type] === 'success' ? 'verified' : 'error'} />}
              </div>

              <div className="flex items-center justify-between text-xs">
                <a href={info.apiKeyHelpUrl} target="_blank" rel="noopener noreferrer" className="text-branch-600 hover:underline font-medium">Get API key →</a>
                {info.apiKeyNote && <span className="text-gray-400 max-w-xs text-right">{info.apiKeyNote}</span>}
              </div>

              <div className="flex flex-wrap gap-1">
                {info.models.map(m => (
                  <span key={m.id} className="inline-flex items-center gap-1 bg-gray-50 border border-gray-100 rounded px-1.5 py-0.5 text-xs">
                    <span className="text-gray-600">{m.name}</span><CostBadge costTier={m.costTier} />
                  </span>
                ))}
              </div>
            </SubCollapsible>
          )
        )}

        <div className="pt-2 border-t border-gray-100 flex items-center justify-between gap-3">
          <p className="text-sm text-gray-500">If keys look wrong or duplicated, clear all saved keys and re-enter them.</p>
          <button className="btn-danger text-xs py-1.5" onClick={() => setConfirmClearKeys(true)}>
            Clear all saved API keys
          </button>
        </div>
      </CollapsibleSection>

      {/* ══════════════════════════════════════════════════════════════════════
          §3  PIPELINE & ROLES — vertical flow-chart style
          ══════════════════════════════════════════════════════════════════════ */}
      <CollapsibleSection
        id="pipeline"
        title="Pipeline & Roles"
        subtitle={`${settings.skipCritics ? 'Critics off' : 'Specialized critics'} · ${settings.maxAdversarialRounds || 3} round${(settings.maxAdversarialRounds || 3) !== 1 ? 's' : ''}`}
        defaultOpen
      >
        <p className="text-xs text-gray-500 mb-2">
          Each profile build follows these steps in order. Configure the search provider, AI models, and review strategy for each stage.
        </p>

        {/* Vertical flow connector */}
        <div className="relative space-y-0">
          {/* Dashed connector line */}
          <div className="absolute left-5 top-8 bottom-8 w-0.5 bg-gradient-to-b from-violet-300 via-sky-300 via-amber-300 to-emerald-300 opacity-40" />

          {/* ═══ STEP 1: Web Research ═══ */}
          <div className="relative pl-12 pb-4">
            <div className="absolute left-2 top-3 w-7 h-7 rounded-full bg-violet-100 border-2 border-violet-400 flex items-center justify-center text-xs font-bold text-violet-700 z-10">1</div>
            <div className="rounded-xl border-2 border-violet-100 bg-gradient-to-br from-violet-50/40 to-white p-4 space-y-3">
              <div>
                <h4 className="text-sm font-bold text-gray-800">🔍 Web Research</h4>
                <p className="text-xs text-gray-500">Search the web for candidate information — campaign sites, social media, news articles</p>
              </div>

              <div className="flex gap-3">
                <label className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-all ${
                  (settings.searchProvider || 'duckduckgo') === 'duckduckgo'
                    ? 'border-branch-500 bg-branch-50 ring-1 ring-branch-200'
                    : 'border-gray-200 hover:border-gray-300'
                }`}>
                  <input type="radio" name="searchProvider" className="sr-only" checked={(settings.searchProvider || 'duckduckgo') === 'duckduckgo'} onChange={() => updateSettings({ searchProvider: 'duckduckgo' })} />
                  <span className="text-lg">🦆</span>
                  <div>
                    <div className="text-sm font-medium text-gray-800">DuckDuckGo</div>
                    <div className="text-xs text-gray-400">Free, no API key needed</div>
                  </div>
                </label>

                <label className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-all ${
                  settings.searchProvider === 'google-cse'
                    ? 'border-branch-500 bg-branch-50 ring-1 ring-branch-200'
                    : 'border-gray-200 hover:border-gray-300'
                }`}>
                  <input type="radio" name="searchProvider" className="sr-only" checked={settings.searchProvider === 'google-cse'} onChange={() => updateSettings({ searchProvider: 'google-cse' })} />
                  <span className="text-lg">🔍</span>
                  <div>
                    <div className="text-sm font-medium text-gray-800">Google Custom Search</div>
                    <div className="text-xs text-gray-400">Requires API key + Engine ID</div>
                  </div>
                </label>
              </div>

              {settings.searchProvider === 'google-cse' && (
                <div className="space-y-3 p-3 bg-gray-50 rounded-lg border border-gray-100">
                  <div>
                    <label className="text-xs font-medium text-gray-600 mb-1 block">Google API Key</label>
                    <div className="flex items-end gap-2">
                      <div className="flex-1 relative">
                        <input
                          type={showGoogleKey ? 'text' : 'password'}
                          className="input text-sm pr-8 w-full font-mono"
                          placeholder="AIza..."
                          autoComplete="off"
                          data-1p-ignore
                          data-lpignore="true"
                          value={settings.googleSearchApiKey || ''}
                          onChange={e => updateSettings({ googleSearchApiKey: e.target.value })}
                        />
                        <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600" onClick={() => setShowGoogleKey(p => !p)}>
                          <EyeIcon open={showGoogleKey} />
                        </button>
                      </div>
                    </div>
                    <p className="text-xs text-gray-400 mt-1">Encrypted alongside your LLM API keys</p>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-600 mb-1 block">Search Engine ID (cx)</label>
                    <div className="relative">
                      <input
                        type={showGoogleCx ? 'text' : 'password'}
                        className="input text-sm w-full font-mono pr-8"
                        placeholder="your-search-engine-id"
                        autoComplete="off"
                        data-1p-ignore
                        data-lpignore="true"
                        value={settings.googleSearchEngineId || ''}
                        onChange={e => updateSettings({ googleSearchEngineId: e.target.value })}
                      />
                      <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600" onClick={() => setShowGoogleCx(p => !p)}>
                        <EyeIcon open={showGoogleCx} />
                      </button>
                    </div>
                    <p className="text-xs text-gray-400 mt-1">
                      Create at <a href="https://programmablesearchengine.google.com/" target="_blank" rel="noopener noreferrer" className="text-branch-600 underline">Programmable Search Engine</a>
                    </p>
                  </div>
                  <div className="flex items-center gap-2 pt-1">
                    <button className="btn-secondary text-xs py-1.5 px-3" onClick={handleTestGoogle} disabled={testingGoogle || !settings.googleSearchApiKey || !settings.googleSearchEngineId}>
                      {testingGoogle ? <Spinner size="sm" /> : 'Test Connection'}
                    </button>
                    {googleTestResult && <StatusBadge status={googleTestResult === 'success' ? 'verified' : 'error'} />}
                    <span className="text-xs text-gray-400">Tests API key + Engine ID with a sample search</span>
                  </div>
                </div>
              )}
            </div>
          </div>



          {/* ═══ STEP 2: Writer ═══ */}
          <div className="relative pl-12 pb-4">
            <div className="absolute left-2 top-3 w-7 h-7 rounded-full bg-sky-100 border-2 border-sky-400 flex items-center justify-center text-xs font-bold text-sky-700 z-10">2</div>
            <div className="rounded-xl border-2 border-sky-100 bg-gradient-to-br from-sky-50/40 to-white p-4 space-y-3">
              <div>
                <h4 className="text-sm font-bold text-gray-800">✍️ Writer Agent</h4>
                <p className="text-xs text-gray-500">Generates the candidate profile from research material</p>
              </div>
              {(() => {
                const role = ROLES[0]; // writer
                const cur = settings.roleAssignments?.[role.key as keyof typeof settings.roleAssignments] as { provider: AIProviderType; model?: string } | undefined;
                const prov = cur?.provider || 'gemini-free';
                const model = cur?.model || AI_PROVIDERS[prov].defaultModel;
                return (
                  <>
                    <ModelPicker providerType={prov} selectedModel={model} onSelect={(p, m) => setRole(role.key, p, m)} compact />
                    {role.promptRole && role.promptDefault && (
                      <PromptEditor role={role.promptRole} label={`${role.label} Prompt`} emoji="✍️" defaultPrompt={role.promptDefault} />
                    )}
                  </>
                );
              })()}
            </div>
          </div>

          {/* ═══ STEP 3: Critic Review ═══ */}
          <div className="relative pl-12 pb-4">
            <div className="absolute left-2 top-3 w-7 h-7 rounded-full bg-amber-100 border-2 border-amber-400 flex items-center justify-center text-xs font-bold text-amber-700 z-10">3</div>
            <div className={`rounded-xl border-2 border-amber-100 bg-gradient-to-br from-amber-50/40 to-white p-4 space-y-3 ${settings.skipCritics ? 'opacity-50' : ''}`}>
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-bold text-gray-800">🔍 Critic Review</h4>
                  <p className="text-xs text-gray-500">Three specialized agents review each draft</p>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <span className="text-xs text-gray-500">{settings.skipCritics ? 'Skipped' : 'Enabled'}</span>
                  <div className={`relative w-9 h-5 rounded-full transition-colors ${settings.skipCritics ? 'bg-gray-300' : 'bg-branch-500'}`} onClick={() => updateSettings({ skipCritics: !settings.skipCritics })}>
                    <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${settings.skipCritics ? 'left-0.5' : 'left-[18px]'}`} />
                  </div>
                </label>
              </div>

              <div>
                <label className="text-xs font-semibold text-gray-600 mb-1 block">Execution</label>
                <select className="input text-sm w-48" value={settings.criticParallelism ?? 'parallel'} onChange={e => updateSettings({ criticParallelism: e.target.value as CriticParallelism })} disabled={settings.skipCritics}>
                  <option value="parallel">Parallel (faster)</option>
                  <option value="sequential">Sequential</option>
                </select>
              </div>

              {/* Specialized critic agents */}
              {CRITIC_AGENTS.map(agent => {
                const cur = settings.roleAssignments?.[agent.key as keyof typeof settings.roleAssignments] as { provider: AIProviderType; model?: string } | undefined;
                const prov = cur?.provider || 'gemini-free';
                const model = cur?.model || AI_PROVIDERS[prov].defaultModel;
                const rc = settings.criticRunCounts ?? { factChecker: 1, languageReviewer: 1, styleAuditor: 1 };
                return (
                  <div key={agent.key} className="bg-white rounded-lg border border-amber-200/60 p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <label className="text-xs font-semibold text-gray-700">{agent.emoji} {agent.label}</label>
                        <p className="text-xs text-gray-400 truncate">{agent.desc}</p>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <label className="text-xs text-gray-400">Runs</label>
                        <input type="number" className="input text-xs w-12 text-center" min={1} max={3} value={rc[agent.rcKey]} onChange={e => { const v = Math.max(1, Math.min(3, parseInt(e.target.value) || 1)); updateSettings({ criticRunCounts: { ...rc, [agent.rcKey]: v } }); }} />
                      </div>
                    </div>
                    <ModelPicker providerType={prov} selectedModel={model} onSelect={(p, m) => setRole(agent.key, p, m)} compact />
                    <PromptEditor role={agent.promptRole} label={`${agent.label} Prompt`} emoji={agent.emoji} defaultPrompt={agent.promptDefault} />
                  </div>
                );
              })}
            </div>
          </div>

          {/* ═══ STEP 4: Adversarial Loop ═══ */}
          <div className="relative pl-12 pb-4">
            <div className="absolute left-2 top-3 w-7 h-7 rounded-full bg-emerald-100 border-2 border-emerald-400 flex items-center justify-center text-xs font-bold text-emerald-700 z-10">4</div>
            <div className="rounded-xl border-2 border-emerald-100 bg-gradient-to-br from-emerald-50/40 to-white p-4 space-y-3">
              <div>
                <h4 className="text-sm font-bold text-gray-800">🔁 Adversarial Loop</h4>
                <p className="text-xs text-gray-500">How many rounds of Writer ↔ Critic feedback</p>
              </div>

              {/* Clarification callout */}
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-xs text-emerald-800">
                <p className="font-semibold mb-1">How it works:</p>
                <div className="flex items-center gap-2 text-emerald-700">
                  <span className="bg-emerald-200 rounded px-1.5 py-0.5 font-mono text-[10px]">Round 1</span>
                  <span>Generate initial draft from research</span>
                </div>
                <div className="flex items-center gap-2 text-emerald-700 mt-1">
                  <span className="bg-emerald-200 rounded px-1.5 py-0.5 font-mono text-[10px]">Round 2+</span>
                  <span><strong>Revise</strong> the existing draft — all stances, bios & links are preserved and refined</span>
                </div>
                <p className="mt-1.5 text-emerald-600 italic">The writer never discards prior work. Every round builds on what came before.</p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-gray-600 mb-1 block">When to Stop</label>
                  <select className="input text-sm" value={settings.convergenceMode} onChange={e => updateSettings({ convergenceMode: e.target.value as AppSettings['convergenceMode'] })}>
                    <option value="human-in-the-loop">Ask me each round</option>
                    <option value="auto-converge">Auto (stop when score is high)</option>
                    <option value="fixed-rounds">Fixed number of rounds</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-600 mb-1 block">Max Rounds</label>
                  <input type="number" className="input text-sm w-full" min={1} max={10} value={settings.maxAdversarialRounds} onChange={e => updateSettings({ maxAdversarialRounds: Math.max(1, Math.min(10, parseInt(e.target.value) || 3)) })} />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-600 mb-1 block">Quality Threshold</label>
                  <input type="number" className="input text-sm w-full" min={0} max={100} value={settings.convergenceThreshold || 80} onChange={e => updateSettings({ convergenceThreshold: Math.max(0, Math.min(100, parseInt(e.target.value) || 80)) })} />
                  <p className="text-xs text-gray-400 mt-0.5">Score ≥ {settings.convergenceThreshold || 80} = done</p>
                </div>
              </div>
            </div>
          </div>

          {/* ═══ STEP 5: Source Verification ═══ */}
          <div className="relative pl-12 pb-4">
            <div className="absolute left-2 top-3 w-7 h-7 rounded-full bg-rose-100 border-2 border-rose-400 flex items-center justify-center text-xs font-bold text-rose-700 z-10">5</div>
            <div className="rounded-xl border-2 border-rose-100 bg-gradient-to-br from-rose-50/40 to-white p-4 space-y-3">
              <div>
                <h4 className="text-sm font-bold text-gray-800">🔍 Source Verification</h4>
                <p className="text-xs text-gray-500">Fetches cited URLs and verifies that quoted content actually appears on the page</p>
              </div>

              <div>
                <label className="text-xs font-semibold text-gray-600 mb-1 block">Verifier Model</label>
                {(() => {
                  const cur = currentVerifiers[0];
                  const prov = cur?.provider || 'gemini-free';
                  const model = cur?.model || AI_PROVIDERS[prov].defaultModel;
                  return (
                    <ModelPicker providerType={prov} selectedModel={model} onSelect={(p, m) => setVerifiers([{ provider: p, model: m }])} compact />
                  );
                })()}
                <p className="text-xs text-gray-400 mt-1">AI model used to verify extracted quotes against source pages.</p>
              </div>
            </div>
          </div>

        </div>{/* end flow container */}
      </CollapsibleSection>

      {/* ══════════════════════════════════════════════════════════════════════
          §4  SESSIONS
          ══════════════════════════════════════════════════════════════════════ */}
      <CollapsibleSection id="data" title="Sessions" subtitle={`${sessions.length} session${sessions.length !== 1 ? 's' : ''}`}>
        {sessions.length === 0 ? (
          <p className="text-sm text-gray-400 italic">No sessions yet.</p>
        ) : (
          <div className="divide-y divide-gray-100">
            {sessions.map(s => (
              <div key={s.id} className="flex items-center justify-between py-2.5">
                <div>
                  <div className="text-sm font-medium text-gray-800">{s.candidateName}</div>
                  <div className="text-xs text-gray-400">{s.status} · {s.builderRounds.length} rounds · {new Date(s.updatedAt).toLocaleString()}</div>
                </div>
                <button className="btn-danger text-xs py-1" onClick={() => setDeletingSession(s.id)}>Delete</button>
              </div>
            ))}
          </div>
        )}
      </CollapsibleSection>

      </div>{/* ══ end left column ══ */}

      {/* ══════════════════════════════════════════════════════════════════════
          RIGHT COLUMN — sticky cost panel
          ══════════════════════════════════════════════════════════════════════ */}
      <div className="w-80 shrink-0 hidden lg:block">
        <div className="sticky top-4 space-y-4 max-h-[calc(100vh-2rem)] overflow-y-auto pr-1">
          {/* ── Spending summary ── */}
          <div className="card p-4 space-y-3 rounded-xl border border-gray-200 bg-white shadow-sm">
            <h3 className="text-sm font-bold text-gray-800">💰 Cost &amp; Spending</h3>

            {/* Monthly spend */}
            <div>
              <div className="text-2xl font-bold text-gray-800">
                ${displaySpend.toFixed(2)}
                {settings.spendingCapUsd > 0 && <span className="text-sm font-normal text-gray-400"> / ${settings.spendingCapUsd.toFixed(2)}</span>}
              </div>
              {settings.spendingCapUsd > 0 && (
                <div className="w-full h-2 bg-gray-200 rounded-full mt-1.5 overflow-hidden">
                  <div className={`h-full rounded-full transition-all ${displaySpend / settings.spendingCapUsd > 0.9 ? 'bg-red-500' : displaySpend / settings.spendingCapUsd > 0.7 ? 'bg-yellow-500' : 'bg-green-500'}`} style={{ width: `${Math.min(100, (displaySpend / settings.spendingCapUsd) * 100)}%` }} />
                </div>
              )}
              <p className="text-xs text-gray-400 mt-1">This month · estimated from local tracking</p>
            </div>

            {/* Spending cap */}
            <div className="border-t border-gray-100 pt-3">
              <label className="text-xs font-semibold text-gray-600 mb-1 block">Monthly Spending Cap</label>
              <div className="flex items-center gap-2">
                <span className="text-gray-400 text-sm">$</span>
                <input type="number" className="input text-sm w-20" min={0} step={1} value={settings.spendingCapUsd} onChange={e => updateSettings({ spendingCapUsd: Math.max(0, parseFloat(e.target.value) || 0) })} />
                <button className="btn-secondary text-xs py-1" onClick={() => { updateSettings({ currentMonthSpendUsd: 0, spendingMonth: currentMonth }); showToast('Spending counter reset', 'info'); }}>Reset</button>
              </div>
              <p className="text-xs text-gray-400 mt-1">0 = unlimited. Always set real limits with your provider.</p>
            </div>
          </div>

          {/* ── Cost calculator ── */}
          <div className="card p-4 space-y-2 rounded-xl border border-gray-200 bg-white shadow-sm">
            <h3 className="text-sm font-bold text-gray-800">🧮 Cost Calculator</h3>
            <p className="text-xs text-gray-400">Estimated cost per profile based on current settings.</p>
            <CostCalculator settings={settings} />
          </div>

          {/* ── Actual cost tracking ── */}
          <div className="card p-4 space-y-2 rounded-xl border border-gray-200 bg-white shadow-sm">
            <h3 className="text-sm font-bold text-gray-800">📊 Actual Costs</h3>
            <p className="text-xs text-gray-400">Real usage from API calls.</p>
            <CostDashboard />
          </div>
        </div>
      </div>

      {/* Delete confirmation */}
      {deletingSession && (
        <ConfirmDialog
          title="Delete Session"
          message="This will permanently delete the session and all its data."
          onConfirm={() => { removeSession(deletingSession); setDeletingSession(null); showToast('Session deleted', 'info'); }}
          onCancel={() => setDeletingSession(null)}
        />
      )}

      {confirmClearKeys && (
        <ConfirmDialog
          title="Clear All API Keys"
          message="This removes all saved API keys from local storage and encrypted vault data. You will need to enter keys again."
          onConfirm={() => {
            clearAllApiKeys();
            setConfirmClearKeys(false);
            showToast('All saved API keys cleared', 'info');
          }}
          onCancel={() => setConfirmClearKeys(false)}
        />
      )}
    </div>
  );
}
