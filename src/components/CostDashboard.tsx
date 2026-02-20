/**
 * Cost Dashboard — Real-time cost tracking panel for the Settings page.
 * Shows actual spend broken down by provider, model, role, and session.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { getCostSummary, getCallLog, clearCostLog, onCostUpdate } from '../services/costTracker';
import type { CostSummary, APICallRecord } from '../types';

function formatUsd(amount: number): string {
  if (amount === 0) return '$0.00';
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

type Tab = 'overview' | 'providers' | 'sessions' | 'log';

export default function CostDashboard() {
  const [tab, setTab] = useState<Tab>('overview');
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [summary, setSummary] = useState<CostSummary>(() => getCostSummary(month));
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  // Re-compute on cost updates
  useEffect(() => {
    const refresh = () => setSummary(getCostSummary(month));
    const unsub = onCostUpdate(refresh);
    refresh(); // initial
    return unsub;
  }, [month]);

  const recentCalls = useMemo(() => {
    return getCallLog(month).slice(-50).reverse();
  }, [summary, month]); // re-derive when summary changes

  if (summary.totalCalls === 0) {
    return (
      <div className="text-center py-8 text-gray-400">
        <svg className="h-10 w-10 mx-auto mb-2 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
        <p className="text-sm font-medium">No API calls recorded yet</p>
        <p className="text-xs mt-1">Cost data will appear here after you use any AI features</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Month selector + top stats */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="shrink-0">
          <input
            type="month"
            className="text-xs border border-gray-200 rounded-lg px-2 py-1 focus:ring-2 focus:ring-branch-500"
            value={month}
            onChange={e => setMonth(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs min-w-0">
          <div className="whitespace-nowrap">
            <span className="text-gray-500">Total{'\u00A0'}Spend:</span>{' '}
            <span className="font-bold text-gray-900">{formatUsd(summary.totalCostUsd)}</span>
          </div>
          <div className="whitespace-nowrap">
            <span className="text-gray-500">Calls:</span>{' '}
            <span className="font-medium text-gray-700">{summary.totalCalls}</span>
          </div>
          <div className="whitespace-nowrap">
            <span className="text-gray-500">Tokens:</span>{' '}
            <span className="font-medium text-gray-700">
              {formatNumber(summary.totalPromptTokens + summary.totalCompletionTokens)}
            </span>
          </div>
        </div>
        <button
          className="text-xs text-red-400 hover:text-red-600 ml-auto shrink-0"
          onClick={() => setShowClearConfirm(true)}
        >
          Clear
        </button>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-gray-200">
        {(['overview', 'providers', 'sessions', 'log'] as Tab[]).map(t => (
          <button
            key={t}
            className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
              tab === t ? 'border-branch-600 text-branch-700' : 'border-transparent text-gray-400 hover:text-gray-600'
            }`}
            onClick={() => setTab(t)}
          >
            {t === 'overview' ? 'Overview' : t === 'providers' ? 'By Provider' : t === 'sessions' ? 'By Session' : 'Call Log'}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'overview' && <OverviewTab summary={summary} />}
      {tab === 'providers' && <ProvidersTab summary={summary} />}
      {tab === 'sessions' && <SessionsTab summary={summary} />}
      {tab === 'log' && <LogTab calls={recentCalls} />}

      {/* Clear confirmation */}
      {showClearConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setShowClearConfirm(false)}>
          <div className="bg-white rounded-xl shadow-lg p-6 max-w-sm" onClick={e => e.stopPropagation()}>
            <h4 className="font-bold text-gray-900">Clear Cost Log?</h4>
            <p className="text-xs text-gray-500 mt-1">This will permanently delete all recorded API call data. This cannot be undone.</p>
            <div className="flex justify-end gap-2 mt-4">
              <button className="btn-secondary text-xs" onClick={() => setShowClearConfirm(false)}>Cancel</button>
              <button className="btn-danger text-xs" onClick={() => { clearCostLog(); setSummary(getCostSummary(month)); setShowClearConfirm(false); }}>
                Delete All
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Overview Tab ────────────────────────────────── */

function OverviewTab({ summary }: { summary: CostSummary }) {
  const roleEntries = Object.entries(summary.byRole).sort((a, b) => b[1].costUsd - a[1].costUsd);
  const maxRoleCost = roleEntries.length > 0 ? Math.max(...roleEntries.map(([, v]) => v.costUsd)) : 1;

  return (
    <div className="space-y-3">
      <h4 className="text-xs font-semibold text-gray-600 uppercase tracking-wider">Cost by Pipeline Role</h4>
      {roleEntries.length === 0 ? (
        <p className="text-xs text-gray-400 italic">No data</p>
      ) : (
        <div className="space-y-2">
          {roleEntries.map(([role, data]) => (
            <div key={role} className="flex items-center gap-3">
              <span className="text-xs font-medium text-gray-700 w-20 capitalize">{role}</span>
              <div className="flex-1 bg-gray-100 rounded-full h-3 overflow-hidden">
                <div
                  className="bg-branch-500 h-full rounded-full transition-all"
                  style={{ width: `${Math.max(2, (data.costUsd / maxRoleCost) * 100)}%` }}
                />
              </div>
              <span className="text-xs font-mono text-gray-600 w-16 text-right">{formatUsd(data.costUsd)}</span>
              <span className="text-xs text-gray-400 w-12 text-right">{data.calls} calls</span>
            </div>
          ))}
        </div>
      )}

      {/* Token breakdown */}
      <div className="grid grid-cols-2 gap-3 pt-3 border-t border-gray-100">
        <div className="bg-gray-50 rounded-lg p-3">
          <div className="text-xs text-gray-500 uppercase tracking-wider">Input Tokens</div>
          <div className="text-sm font-bold text-gray-800 mt-0.5">{formatNumber(summary.totalPromptTokens)}</div>
        </div>
        <div className="bg-gray-50 rounded-lg p-3">
          <div className="text-xs text-gray-500 uppercase tracking-wider">Output Tokens</div>
          <div className="text-sm font-bold text-gray-800 mt-0.5">{formatNumber(summary.totalCompletionTokens)}</div>
        </div>
      </div>
    </div>
  );
}

/* ─── Providers Tab ───────────────────────────────── */

function ProvidersTab({ summary }: { summary: CostSummary }) {
  const modelEntries = Object.entries(summary.byModel).sort((a, b) => b[1].costUsd - a[1].costUsd);

  return (
    <div className="space-y-3">
      <h4 className="text-xs font-semibold text-gray-600 uppercase tracking-wider">Cost by Model</h4>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-gray-400 border-b border-gray-100">
              <th className="pb-2 font-medium">Model</th>
              <th className="pb-2 font-medium text-right">Cost</th>
              <th className="pb-2 font-medium text-right">Calls</th>
              <th className="pb-2 font-medium text-right">Avg/Call</th>
            </tr>
          </thead>
          <tbody>
            {modelEntries.map(([model, data]) => (
              <tr key={model} className="border-b border-gray-50">
                <td className="py-1.5 font-mono text-gray-700">{model}</td>
                <td className="py-1.5 text-right font-medium">{formatUsd(data.costUsd)}</td>
                <td className="py-1.5 text-right text-gray-500">{data.calls}</td>
                <td className="py-1.5 text-right text-gray-400">{formatUsd(data.costUsd / data.calls)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Provider summary */}
      <div className="pt-3 border-t border-gray-100">
        <h4 className="text-xs font-semibold text-gray-600 uppercase tracking-wider mb-2">By Provider</h4>
        <div className="flex flex-wrap gap-2">
          {Object.entries(summary.byProvider).sort((a, b) => b[1].costUsd - a[1].costUsd).map(([provider, data]) => (
            <div key={provider} className="bg-gray-50 rounded-lg px-3 py-1.5">
              <span className="text-xs font-medium text-gray-700">{provider}</span>
              <span className="text-xs text-gray-500 ml-2">{formatUsd(data.costUsd)} · {data.calls} calls</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── Sessions Tab ────────────────────────────────── */

function SessionsTab({ summary }: { summary: CostSummary }) {
  const sessionEntries = Object.entries(summary.bySession).sort((a, b) => b[1].costUsd - a[1].costUsd);

  if (sessionEntries.length === 0) {
    return <p className="text-xs text-gray-400 italic py-4">No session-linked calls yet. Use tracked providers in the build pipeline to see per-candidate costs.</p>;
  }

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold text-gray-600 uppercase tracking-wider">Cost per Candidate Session</h4>
      {sessionEntries.map(([sessionId, data]) => (
        <div key={sessionId} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2">
          <div>
            <span className="text-xs font-semibold text-gray-800">{data.candidateName}</span>
            <span className="text-xs text-gray-400 ml-2">{sessionId.slice(0, 8)}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium">{formatUsd(data.costUsd)}</span>
            <span className="text-xs text-gray-400">{data.calls} calls</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ─── Call Log Tab ────────────────────────────────── */

function LogTab({ calls }: { calls: APICallRecord[] }) {
  if (calls.length === 0) {
    return <p className="text-xs text-gray-400 italic py-4">No calls recorded this month.</p>;
  }

  return (
    <div className="space-y-1 max-h-[50vh] overflow-y-auto">
      <div className="text-xs text-gray-400 mb-2">Showing last {calls.length} calls (newest first)</div>
      {calls.map(call => (
        <div
          key={call.id}
          className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs ${
            call.success ? 'bg-white' : 'bg-red-50'
          }`}
        >
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${call.success ? 'bg-green-400' : 'bg-red-400'}`} />
          <span className="text-gray-400 w-14 shrink-0">
            {new Date(call.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
          <span className="text-gray-600 font-medium capitalize w-14 shrink-0">{call.role}</span>
          <span className="text-gray-500 font-mono truncate flex-1">{call.model}</span>
          <span className="text-gray-500 shrink-0">
            {formatNumber(call.usage.totalTokens)} tok
          </span>
          <span className="font-medium text-gray-700 w-12 text-right shrink-0">{formatUsd(call.costUsd)}</span>
          <span className="text-gray-400 w-10 text-right shrink-0">{call.durationMs}ms</span>
        </div>
      ))}
    </div>
  );
}
