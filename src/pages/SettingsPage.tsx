import React, { useState, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import {
  AI_PROVIDERS,
  PIPELINE_MODE_INFO,
  type AIProviderType,
  type AppSettings,
  type CriticRunCounts,
  type CriticParallelism,
  type PipelineMode,
  type CriticMode,
  type AuditMode,
} from '../types';
import { Spinner, StatusBadge, ConfirmDialog } from '../components/shared';
import { ModelPicker, CostBadge } from '../components/ModelPicker';
import CostCalculator from '../components/CostCalculator';
import CostDashboard from '../components/CostDashboard';

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
  { key: 'writer', label: 'Writer Agent', desc: 'Generates the candidate profile' },
  { key: 'extractor', label: 'Claim Extractor', desc: 'Extracts verifiable claims' },
] as const;

const CRITIC_AGENTS = [
  { key: 'factChecker', label: 'Fact Checker', emoji: '🔬', desc: 'Verifies factual accuracy, sources, identity matching, and unsupported claims', rcKey: 'factChecker' as keyof CriticRunCounts },
  { key: 'languageReviewer', label: 'Language Reviewer', emoji: '📝', desc: 'Checks for biased and partisan language using the substitution chart', rcKey: 'languageReviewer' as keyof CriticRunCounts },
  { key: 'styleAuditor', label: 'Style & Template Auditor', emoji: '📐', desc: 'Enforces formatting rules — name usage, degree casing, stance unbundling, etc.', rcKey: 'styleAuditor' as keyof CriticRunCounts },
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
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${badgeColor || 'bg-gray-100 text-gray-600'}`}>
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
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${badgeColor || 'bg-gray-100 text-gray-600'}`}>
              {badge}
            </span>
          )}
          {subtitle && <span className="text-[10px] text-gray-400 truncate hidden sm:inline">{subtitle}</span>}
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

/* ═══════════════════════════ MAIN PAGE ═══════════════════════════════════ */
export default function SettingsPage() {
  const { settings, updateSettings, setApiKey, sessions, removeSession, showToast, clearAllApiKeys } = useApp();
  const [testingProvider, setTestingProvider] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, 'success' | 'error'>>({});
  const [deletingSession, setDeletingSession] = useState<string | null>(null);
  const [showKeyValues, setShowKeyValues] = useState<Record<string, boolean>>({});
  const [confirmClearKeys, setConfirmClearKeys] = useState(false);

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
    <div className="space-y-4 max-w-3xl">
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
                  <span className="text-[10px] text-gray-400">(shared between Free & Paid tiers)</span>
                </div>
                <div className="flex items-end gap-2">
                  <div className="flex-1 relative">
                    <input
                      type={showKeyValues['gemini'] ? 'text' : 'password'}
                      className="input text-sm font-mono pr-8"
                      placeholder="Enter Google AI Studio API key…"
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
                <div className="flex items-center justify-between text-[10px]">
                  <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="text-branch-600 hover:underline font-medium">Get API key →</a>
                  <span className="text-gray-400">One key works for both Free and Paid tiers.</span>
                </div>
              </div>

              {/* Rate limit info */}
              <div className="space-y-2 border-t border-gray-100 pt-3">
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                  <div className="flex items-start gap-2">
                    <span className="text-amber-500 text-sm mt-0.5">ℹ️</span>
                    <div className="text-[11px] text-amber-800 space-y-1">
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

              {/* Models */}
              <div className="border-t border-gray-100 pt-2">
                <details>
                  <summary className="cursor-pointer text-[10px] font-medium text-gray-500 hover:underline">
                    Models ({AI_PROVIDERS['gemini-free'].models.length} free + {AI_PROVIDERS['gemini-paid'].models.length} paid)
                  </summary>
                  <div className="mt-2 space-y-2">
                    <div>
                      <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Free Tier</span>
                      <div className="flex flex-wrap gap-1 mt-0.5">
                        {AI_PROVIDERS['gemini-free'].models.map(m => (
                          <span key={m.id} className="inline-flex items-center gap-1 bg-gray-50 border border-gray-100 rounded px-1.5 py-0.5 text-[10px]">
                            <span className="text-gray-600">{m.name}</span><CostBadge costTier={m.costTier} />
                          </span>
                        ))}
                      </div>
                    </div>
                    <div>
                      <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Paid Tier</span>
                      <div className="flex flex-wrap gap-1 mt-0.5">
                        {AI_PROVIDERS['gemini-paid'].models.map(m => (
                          <span key={m.id} className="inline-flex items-center gap-1 bg-gray-50 border border-gray-100 rounded px-1.5 py-0.5 text-[10px]">
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
              <p className="text-[10px] text-gray-400">{info.description}</p>

              <div className="flex items-end gap-2">
                <div className="flex-1 relative">
                  <input
                    type={showKeyValues[type] ? 'text' : 'password'}
                    className="input text-sm font-mono pr-8"
                    placeholder={`Enter ${info.name} API key…`}
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

              <div className="flex items-center justify-between text-[10px]">
                <a href={info.apiKeyHelpUrl} target="_blank" rel="noopener noreferrer" className="text-branch-600 hover:underline font-medium">Get API key →</a>
                {info.apiKeyNote && <span className="text-gray-400 max-w-xs text-right">{info.apiKeyNote}</span>}
              </div>

              <div className="flex flex-wrap gap-1">
                {info.models.map(m => (
                  <span key={m.id} className="inline-flex items-center gap-1 bg-gray-50 border border-gray-100 rounded px-1.5 py-0.5 text-[10px]">
                    <span className="text-gray-600">{m.name}</span><CostBadge costTier={m.costTier} />
                  </span>
                ))}
              </div>
            </SubCollapsible>
          )
        )}

        <div className="pt-2 border-t border-gray-100 flex items-center justify-between gap-3">
          <p className="text-[11px] text-gray-500">If keys look wrong or duplicated, clear all saved keys and re-enter them.</p>
          <button className="btn-danger text-xs py-1.5" onClick={() => setConfirmClearKeys(true)}>
            Clear all saved API keys
          </button>
        </div>
      </CollapsibleSection>

      {/* ══════════════════════════════════════════════════════════════════════
          §2  COST & SPENDING
          ══════════════════════════════════════════════════════════════════════ */}
      <CollapsibleSection
        id="cost"
        title="Cost & Spending"
        subtitle={`This month: $${displaySpend.toFixed(2)}${settings.spendingCapUsd > 0 ? ` / $${settings.spendingCapUsd.toFixed(2)}` : ''}`}
      >
        {/* Spending cap */}
        <div className="space-y-3">
          <label className="text-sm font-medium text-gray-700">Monthly Spending Cap</label>
          <p className="text-xs text-gray-400">Estimated limit tracked locally. 0 = unlimited. <em>Always set real limits with each provider.</em></p>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-gray-400">$</span>
              <input type="number" className="input text-sm w-28" min={0} step={1} value={settings.spendingCapUsd} onChange={e => updateSettings({ spendingCapUsd: Math.max(0, parseFloat(e.target.value) || 0) })} />
            </div>
            <div className="border-l border-gray-200 pl-4">
              <div className="text-lg font-bold text-gray-800">
                ${displaySpend.toFixed(2)}
                {settings.spendingCapUsd > 0 && <span className="text-sm font-normal text-gray-400"> / ${settings.spendingCapUsd.toFixed(2)}</span>}
              </div>
              {settings.spendingCapUsd > 0 && (
                <div className="w-40 h-2 bg-gray-200 rounded-full mt-1 overflow-hidden">
                  <div className={`h-full rounded-full transition-all ${displaySpend / settings.spendingCapUsd > 0.9 ? 'bg-red-500' : displaySpend / settings.spendingCapUsd > 0.7 ? 'bg-yellow-500' : 'bg-green-500'}`} style={{ width: `${Math.min(100, (displaySpend / settings.spendingCapUsd) * 100)}%` }} />
                </div>
              )}
            </div>
            <button className="btn-secondary text-xs" onClick={() => { updateSettings({ currentMonthSpendUsd: 0, spendingMonth: currentMonth }); showToast('Spending counter reset', 'info'); }}>Reset</button>
          </div>
        </div>

        {/* Cost calculator */}
        <div className="border-t border-gray-100 pt-4 space-y-2">
          <label className="text-sm font-medium text-gray-700">Cost Calculator</label>
          <p className="text-xs text-gray-400">Estimated cost per profile based on current settings.</p>
          <CostCalculator settings={settings} />
        </div>

        {/* Cost dashboard */}
        <div className="border-t border-gray-100 pt-4 space-y-2">
          <label className="text-sm font-medium text-gray-700">Actual Cost Tracking</label>
          <p className="text-xs text-gray-400">Real usage and cost data from all API calls.</p>
          <CostDashboard />
        </div>
      </CollapsibleSection>

      {/* ══════════════════════════════════════════════════════════════════════
          §3  PIPELINE & ROLES
          ══════════════════════════════════════════════════════════════════════ */}
      <CollapsibleSection
        id="pipeline"
        title="Pipeline & Roles"
        subtitle={`${PIPELINE_MODE_INFO[settings.pipelineMode || 'balanced'].label} · ${settings.criticMode === 'specialized' ? 'Specialized critics' : 'Combined critic'} · ${settings.auditMode === 'skip' ? 'No audit' : settings.auditMode === 'multi-verifier' ? 'Multi-verifier' : 'Single-verifier'}`}
      >
        {/* ─── SECTION 1: Quality Mode ─── */}
        <div className="rounded-xl border-2 border-indigo-100 bg-gradient-to-br from-indigo-50/40 to-white p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className="w-7 h-7 rounded-lg bg-indigo-100 flex items-center justify-center text-sm">⚡</span>
            <div>
              <h4 className="text-sm font-bold text-gray-800">Quality Mode</h4>
              <p className="text-[10px] text-gray-500">How thorough each profile build should be</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(Object.entries(PIPELINE_MODE_INFO) as [PipelineMode, typeof PIPELINE_MODE_INFO[PipelineMode]][]).map(([mode, mi]) => (
              <label key={mode} className={`cursor-pointer rounded-lg border-2 p-2.5 transition-all ${(settings.pipelineMode || 'balanced') === mode ? 'border-indigo-400 bg-indigo-50 shadow-sm' : 'border-gray-200 bg-white hover:border-gray-300'}`}>
                <input type="radio" name="pipelineMode" className="sr-only" checked={(settings.pipelineMode || 'balanced') === mode} onChange={() => updateSettings({ pipelineMode: mode })} />
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-sm font-semibold text-gray-800">{mi.label}</span>
                  <span className={`text-[10px] font-mono font-medium px-1.5 py-0.5 rounded ${(settings.pipelineMode || 'balanced') === mode ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-500'}`}>{mi.approxCalls}</span>
                </div>
                <p className="text-[10px] text-gray-500">{mi.description}</p>
              </label>
            ))}
          </div>
        </div>

        {/* ─── SECTION 2: Review Strategy ─── */}
        <div className="rounded-xl border-2 border-amber-100 bg-gradient-to-br from-amber-50/40 to-white p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className="w-7 h-7 rounded-lg bg-amber-100 flex items-center justify-center text-sm">🔍</span>
            <div>
              <h4 className="text-sm font-bold text-gray-800">Review Strategy</h4>
              <p className="text-[10px] text-gray-500">How profiles are critiqued and fact-checked</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-gray-600 mb-1 block">Critic Mode</label>
              <select className="input text-sm" value={settings.criticMode || 'combined'} onChange={e => updateSettings({ criticMode: e.target.value as CriticMode })} disabled={(settings.pipelineMode || 'balanced') === 'draft'}>
                <option value="combined">Combined (1 call)</option>
                <option value="specialized">Specialized (3 agents)</option>
              </select>
              <p className="text-[10px] text-gray-400 mt-1">{(settings.pipelineMode || 'balanced') === 'draft' ? '⏭ Skipped in Draft mode' : 'Combined = faster. Specialized = deeper review.'}</p>
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-600 mb-1 block">Fact-Check Mode</label>
              <select className="input text-sm" value={settings.auditMode || 'single-verifier'} onChange={e => updateSettings({ auditMode: e.target.value as AuditMode })} disabled={(settings.pipelineMode || 'balanced') === 'draft'}>
                <option value="single-verifier">Single Verifier</option>
                <option value="multi-verifier">Multi-Verifier (consensus)</option>
                <option value="skip">Skip Fact-Check</option>
              </select>
              <p className="text-[10px] text-gray-400 mt-1">{(settings.pipelineMode || 'balanced') === 'draft' ? '⏭ Skipped in Draft mode' : 'Runs automatically after the build.'}</p>
            </div>
          </div>
        </div>

        {/* ─── SECTION 3: Adversarial Loop ─── */}
        <div className="rounded-xl border-2 border-emerald-100 bg-gradient-to-br from-emerald-50/40 to-white p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className="w-7 h-7 rounded-lg bg-emerald-100 flex items-center justify-center text-sm">🔁</span>
            <div>
              <h4 className="text-sm font-bold text-gray-800">Adversarial Loop</h4>
              <p className="text-[10px] text-gray-500">How many rounds of Writer ↔ Critic feedback</p>
            </div>
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
              <label className="text-xs font-semibold text-gray-600 mb-1 block">Critic Execution</label>
              <select className="input text-sm" value={settings.criticParallelism ?? 'parallel'} onChange={e => updateSettings({ criticParallelism: e.target.value as CriticParallelism })}>
                <option value="parallel">Parallel (faster)</option>
                <option value="sequential">Sequential</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-600 mb-1 block">Max Rounds</label>
              <input type="number" className="input text-sm w-full" min={1} max={10} value={settings.maxAdversarialRounds} onChange={e => updateSettings({ maxAdversarialRounds: Math.max(1, Math.min(10, parseInt(e.target.value) || 3)) })} />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-600 mb-1 block">Quality Threshold</label>
              <input type="number" className="input text-sm w-full" min={0} max={100} value={settings.convergenceThreshold || 80} onChange={e => updateSettings({ convergenceThreshold: Math.max(0, Math.min(100, parseInt(e.target.value) || 80)) })} />
              <p className="text-[10px] text-gray-400 mt-0.5">Score ≥ {settings.convergenceThreshold || 80} = done</p>
            </div>
          </div>
        </div>

        {/* ─── SECTION 4: AI Assignments ─── */}
        <div className="rounded-xl border-2 border-sky-100 bg-gradient-to-br from-sky-50/40 to-white p-4 space-y-4">
          <div className="flex items-center gap-2">
            <span className="w-7 h-7 rounded-lg bg-sky-100 flex items-center justify-center text-sm">🤖</span>
            <div>
              <h4 className="text-sm font-bold text-gray-800">AI Assignments</h4>
              <p className="text-[10px] text-gray-500">Which AI model handles each step of the pipeline</p>
            </div>
          </div>

          {/* Writer & Extractor */}
          <div className="space-y-2">
            <span className="text-[10px] font-bold text-sky-600 uppercase tracking-wider">Core Agents</span>
            {ROLES.map(role => {
              const cur = settings.roleAssignments?.[role.key as keyof typeof settings.roleAssignments] as { provider: AIProviderType; model?: string } | undefined;
              const prov = cur?.provider || 'gemini-free';
              const model = cur?.model || AI_PROVIDERS[prov].defaultModel;
              return (
                <div key={role.key} className="bg-white rounded-lg border border-sky-200/60 p-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <label className="text-xs font-semibold text-gray-700">{role.label}</label>
                    <p className="text-[10px] text-gray-400 truncate">{role.desc}</p>
                  </div>
                  <select className="input text-xs w-36" value={prov} onChange={e => setRole(role.key, e.target.value as AIProviderType)}>
                    {PROVIDER_ENTRIES.map(([t, inf]) => <option key={t} value={t}>{inf.name}</option>)}
                  </select>
                  <ModelPicker providerType={prov} selectedModel={model} onSelect={m => setRoleModel(role.key, m)} compact />
                </div>
              );
            })}
          </div>

          {/* Critic agents */}
          <div className="space-y-2">
            <span className="text-[10px] font-bold text-amber-600 uppercase tracking-wider">Critic Agents</span>
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
                      <p className="text-[10px] text-gray-400 truncate">{agent.desc}</p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <label className="text-[10px] text-gray-400">Runs</label>
                      <input type="number" className="input text-xs w-12 text-center" min={1} max={3} value={rc[agent.rcKey]} onChange={e => { const v = Math.max(1, Math.min(3, parseInt(e.target.value) || 1)); updateSettings({ criticRunCounts: { ...rc, [agent.rcKey]: v } }); }} />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <select className="input text-xs flex-1" value={prov} onChange={e => setRole(agent.key, e.target.value as AIProviderType)}>
                      {PROVIDER_ENTRIES.map(([t, inf]) => <option key={t} value={t}>{inf.name}</option>)}
                    </select>
                    <ModelPicker providerType={prov} selectedModel={model} onSelect={m => setRoleModel(agent.key, m)} compact />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Verifiers */}
          <div className="space-y-2">
            <span className="text-[10px] font-bold text-green-600 uppercase tracking-wider">Fact-Check Verifiers</span>
            <div className="bg-white rounded-lg border border-green-200/60 p-3 space-y-2">
              <p className="text-[10px] text-gray-400">Multiple verifiers cross-check each other for consensus-based fact-checking.</p>
              {currentVerifiers.map((v, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select className="input text-xs flex-1" value={v.provider} onChange={e => { const updated = [...currentVerifiers]; const np = e.target.value as AIProviderType; updated[i] = { provider: np, model: AI_PROVIDERS[np].defaultModel }; setVerifiers(updated); }}>
                    {PROVIDER_ENTRIES.map(([t, inf]) => <option key={t} value={t}>{inf.name}</option>)}
                  </select>
                  <ModelPicker providerType={v.provider} selectedModel={v.model || AI_PROVIDERS[v.provider].defaultModel} onSelect={m => { const updated = [...currentVerifiers]; updated[i] = { ...updated[i], model: m }; setVerifiers(updated); }} compact />
                  {currentVerifiers.length > 1 && <button className="text-red-400 hover:text-red-600 text-xs px-1.5" onClick={() => setVerifiers(currentVerifiers.filter((_, j) => j !== i))}>✕</button>}
                </div>
              ))}
              <button className="text-xs text-branch-600 hover:underline font-medium" onClick={() => setVerifiers([...currentVerifiers, { provider: 'gemini-free' }])}>+ Add verifier</button>
            </div>
          </div>
        </div>
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
                  <div className="text-[10px] text-gray-400">{s.status} · {s.builderRounds.length} rounds · {new Date(s.updatedAt).toLocaleString()}</div>
                </div>
                <button className="btn-danger text-xs py-1" onClick={() => setDeletingSession(s.id)}>Delete</button>
              </div>
            ))}
          </div>
        )}
      </CollapsibleSection>

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
