/**
 * Cost Tracker Service
 *
 * Tracks actual token usage and costs across all AI API calls.
 * Persists to localStorage for financial tracking.
 * Provides summaries by provider, model, role, and session.
 */

import type { AIProviderType, APICallRecord, CostSummary, TokenUsage } from '../types';
import { AI_PROVIDERS } from '../types';
import { v4 as uuid } from 'uuid';

const STORAGE_KEY = 'branch-playground-cost-log';
const MONTH_KEY = 'branch-playground-cost-month';

// ── Helpers ──────────────────────────────────────────────────────────────────

function getModelInfo(provider: AIProviderType, modelId: string) {
  const providerConfig = AI_PROVIDERS[provider];
  const model = providerConfig?.models.find(m => m.id === modelId) ?? null;

  // Safety fallback: if gemini-free model has no pricing, try gemini-paid
  // This handles records logged before the tier-resolution fix was added
  if (model && !model.costPerMillionTokens && provider === 'gemini-free') {
    const paidModel = AI_PROVIDERS['gemini-paid']?.models.find(m => m.id === modelId);
    if (paidModel?.costPerMillionTokens) return paidModel;
  }

  return model;
}

/** Compute cost in USD from token counts */
export function computeCost(
  provider: AIProviderType,
  modelId: string,
  usage: TokenUsage,
): number {
  const model = getModelInfo(provider, modelId);
  if (!model) return 0;

  const inputCost = (model.costPerMillionTokens ?? 0) * (usage.promptTokens / 1_000_000);
  const outputCost = (model.outputCostPerMillionTokens ?? model.costPerMillionTokens ?? 0) * (usage.completionTokens / 1_000_000);
  return inputCost + outputCost;
}

// ── Storage ──────────────────────────────────────────────────────────────────

function loadLog(): APICallRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as APICallRecord[];
  } catch {
    return [];
  }
}

function saveLog(records: APICallRecord[]) {
  // Keep only the last 10,000 records to avoid bloating localStorage
  const trimmed = records.slice(-10_000);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
}

function getCurrentMonth(): string {
  return new Date().toISOString().slice(0, 7); // "YYYY-MM"
}

// ── Core API ─────────────────────────────────────────────────────────────────

let _log: APICallRecord[] | null = null;

function getLog(): APICallRecord[] {
  if (_log === null) _log = loadLog();
  return _log;
}

/** Record a completed API call. Returns the record. */
export function recordAPICall(params: {
  provider: AIProviderType;
  model: string;
  role: string;
  sessionId?: string;
  candidateName?: string;
  usage: TokenUsage;
  durationMs: number;
  success: boolean;
  error?: string;
}): APICallRecord {
  const costUsd = computeCost(params.provider, params.model, params.usage);

  const record: APICallRecord = {
    id: uuid(),
    timestamp: new Date().toISOString(),
    provider: params.provider,
    model: params.model,
    role: params.role,
    sessionId: params.sessionId,
    candidateName: params.candidateName,
    usage: params.usage,
    costUsd,
    durationMs: params.durationMs,
    success: params.success,
    error: params.error,
  };

  const log = getLog();
  log.push(record);
  saveLog(log);

  // Also update monthly spend
  updateMonthlySpend(costUsd);

  // Notify listeners
  _listeners.forEach(fn => fn(record));

  return record;
}

/** Get all records, optionally filtered by month */
export function getCallLog(month?: string): APICallRecord[] {
  const log = getLog();
  if (!month) return log;
  return log.filter(r => r.timestamp.startsWith(month));
}

/** Get summary of costs */
export function getCostSummary(month?: string): CostSummary {
  const records = getCallLog(month);

  const summary: CostSummary = {
    totalCostUsd: 0,
    totalCalls: records.length,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    byProvider: {},
    byModel: {},
    byRole: {},
    bySession: {},
  };

  for (const r of records) {
    summary.totalCostUsd += r.costUsd;
    summary.totalPromptTokens += r.usage.promptTokens;
    summary.totalCompletionTokens += r.usage.completionTokens;

    // By provider
    if (!summary.byProvider[r.provider]) summary.byProvider[r.provider] = { costUsd: 0, calls: 0 };
    summary.byProvider[r.provider].costUsd += r.costUsd;
    summary.byProvider[r.provider].calls += 1;

    // By model
    if (!summary.byModel[r.model]) summary.byModel[r.model] = { costUsd: 0, calls: 0 };
    summary.byModel[r.model].costUsd += r.costUsd;
    summary.byModel[r.model].calls += 1;

    // By role
    if (!summary.byRole[r.role]) summary.byRole[r.role] = { costUsd: 0, calls: 0 };
    summary.byRole[r.role].costUsd += r.costUsd;
    summary.byRole[r.role].calls += 1;

    // By session
    if (r.sessionId) {
      if (!summary.bySession[r.sessionId]) {
        summary.bySession[r.sessionId] = { costUsd: 0, calls: 0, candidateName: r.candidateName || 'Unknown' };
      }
      summary.bySession[r.sessionId].costUsd += r.costUsd;
      summary.bySession[r.sessionId].calls += 1;
    }
  }

  return summary;
}

/** Get the current month's total spend */
export function getCurrentMonthSpend(): number {
  const summary = getCostSummary(getCurrentMonth());
  return summary.totalCostUsd;
}

/** Clear all cost records */
export function clearCostLog() {
  _log = [];
  saveLog([]);
}

// ── Monthly spend tracking (updates AppSettings.currentMonthSpendUsd) ────────

function updateMonthlySpend(additionalCost: number) {
  // This updates a lightweight counter in localStorage for the spending cap feature
  const currentMonth = getCurrentMonth();
  const storedMonth = localStorage.getItem(MONTH_KEY) || '';

  if (storedMonth !== currentMonth) {
    // New month — reset
    localStorage.setItem(MONTH_KEY, currentMonth);
  }

  // The actual monthly spend is computed from the call log via getCostSummary,
  // but we also keep settings.currentMonthSpendUsd in sync for the spending cap.
  // This is done via the listener mechanism below.
}

// ── Listener system (for real-time UI updates) ───────────────────────────────

type CostListener = (record: APICallRecord) => void;
const _listeners: Set<CostListener> = new Set();

export function onCostUpdate(listener: CostListener): () => void {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

// ── Estimate accuracy tracking ───────────────────────────────────────────────

/**
 * Returns average tokens per call for a given role, useful for improving
 * the CostCalculator estimates based on actual usage patterns.
 */
export function getAverageTokensPerRole(role: string, provider?: AIProviderType): {
  avgPromptTokens: number;
  avgCompletionTokens: number;
  sampleSize: number;
} {
  const log = getLog();
  const filtered = log.filter(r =>
    r.role === role && r.success && (provider ? r.provider === provider : true)
  );

  if (filtered.length === 0) {
    return { avgPromptTokens: 0, avgCompletionTokens: 0, sampleSize: 0 };
  }

  const totalPrompt = filtered.reduce((sum, r) => sum + r.usage.promptTokens, 0);
  const totalCompletion = filtered.reduce((sum, r) => sum + r.usage.completionTokens, 0);

  return {
    avgPromptTokens: Math.round(totalPrompt / filtered.length),
    avgCompletionTokens: Math.round(totalCompletion / filtered.length),
    sampleSize: filtered.length,
  };
}
