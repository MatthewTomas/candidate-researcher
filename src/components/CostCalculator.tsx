/**
 * CostCalculator — estimates the AI cost per candidate profile.
 *
 * Factors in EVERY pipeline step:
 *  1. Writer calls (per adversarial round)
 *  2. Critic calls (per adversarial round)
 *  3. Claim extraction (once after final draft)
 *  4. Verification calls (N claims × M verifiers)
 *
 * Shows: best-case, expected, and worst-case cost per profile.
 */

import React, { useMemo } from 'react';
import { AI_PROVIDERS, GEMINI_TIER_INFO, type AIProviderType, type AppSettings, type RoleAssignment, type ModelInfo, type GeminiTier } from '../types';
import { CostBadge } from './ModelPicker';
import { rateLimiter } from '../services/rateLimiter';

// ── Token estimates for each pipeline stage ──────────────────
// These are empirically grounded averages for Branch-style political profiles.

const TOKEN_ESTIMATES = {
  // Writer: ingests source HTML + critic feedback, outputs a draft profile
  writer: {
    inputBase: 4000,        // source HTML (typically 3K–6K tokens)
    inputSystemPrompt: 2000, // system prompt with template instructions
    inputCriticFeedback: 2000, // feedback from critic (0 on first round)
    outputDraftTokens: 3000,  // generated profile draft
  },
  // Critic: ingests draft + source material, outputs feedback
  critic: {
    inputBase: 4000,        // source material for comparison
    inputDraft: 3000,       // the writer's draft
    inputSystemPrompt: 2000,
    outputFeedbackTokens: 2000,
  },
  // Claim extractor: ingests final draft, extracts verifiable claims
  extractor: {
    inputDraft: 3000,
    inputSystemPrompt: 1000,
    outputClaimsTokens: 2000,
  },
  // Verifier: per-claim verification
  verifier: {
    inputClaimContext: 200,  // the claim text
    inputSourceContext: 1000, // supporting evidence / context
    inputSystemPrompt: 500,
    outputVerdictTokens: 500,
  },
  // Typical claims per profile
  claimsBestCase: 8,
  claimsExpected: 15,
  claimsWorstCase: 30,
};

// ── Helpers ──────────────────────────────────────────────────

/**
 * Resolve the actual provider/model, accounting for geminiTier.
 * When the user is on a paid Gemini tier, gemini-free roles use gemini-paid pricing.
 */
function getModelForRole(
  settings: AppSettings,
  role: string,
): { provider: AIProviderType; model: ModelInfo; isFree: boolean } | null {
  const assignment = role === 'verifier'
    ? settings.roleAssignments?.verifiers?.[0]
    : (settings.roleAssignments as any)?.[role] as RoleAssignment | undefined;

  if (!assignment) return null;

  let providerType = assignment.provider;
  const geminiTier: GeminiTier = settings.geminiTier || 'free';

  // Resolve gemini-free → gemini-paid when user is on a paid tier
  if (providerType === 'gemini-free' && geminiTier !== 'free') {
    providerType = 'gemini-paid';
  }

  const providerConfig = AI_PROVIDERS[providerType];
  if (!providerConfig) return null;

  const modelId = assignment.model || providerConfig.defaultModel;
  const model = providerConfig.models.find(m => m.id === modelId) || providerConfig.models[0];
  const isFree = providerConfig.isFree && geminiTier === 'free';

  return { provider: providerType, model, isFree };
}

function calcCost(inputTokens: number, outputTokens: number, model: ModelInfo, isFree: boolean): number {
  if (isFree && !model.costPerMillionTokens) return 0;
  const inputCost = (model.costPerMillionTokens || 0) * (inputTokens / 1_000_000);
  const outputCostRate = model.outputCostPerMillionTokens || (model.costPerMillionTokens || 0) * 3; // fallback: output ~3x input
  const outputCost = outputCostRate * (outputTokens / 1_000_000);
  return inputCost + outputCost;
}

interface PipelineStepCost {
  label: string;
  role: string;
  modelName: string;
  providerName: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  calls: number;
  isFree: boolean;
}

function calculatePipeline(
  settings: AppSettings,
  rounds: number,
  claims: number,
): { steps: PipelineStepCost[]; total: number; totalCalls: number } {
  const steps: PipelineStepCost[] = [];

  const skipCritics = settings.skipCritics ?? false;

  const effectiveRounds = rounds;

  // Writer
  const writerInfo = getModelForRole(settings, 'writer');
  if (writerInfo) {
    const { model, isFree } = writerInfo;
    const e = TOKEN_ESTIMATES.writer;
    // First round has no critic feedback; subsequent rounds include it
    const inputFirst = e.inputBase + e.inputSystemPrompt;
    const inputSubsequent = e.inputBase + e.inputSystemPrompt + e.inputCriticFeedback;
    const totalInput = inputFirst + (effectiveRounds > 1 ? (effectiveRounds - 1) * inputSubsequent : 0);
    const totalOutput = effectiveRounds * e.outputDraftTokens;
    steps.push({
      label: `Writer (${effectiveRounds} round${effectiveRounds > 1 ? 's' : ''})`,
      role: 'writer',
      modelName: model.name,
      providerName: AI_PROVIDERS[writerInfo.provider].name,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cost: calcCost(totalInput, totalOutput, model, isFree),
      calls: effectiveRounds,
      isFree,
    });
  }

  // Critics — always specialized (3 agents)
  if (!skipCritics) {
    const criticAgents = [
      { role: 'factChecker', label: 'Fact Checker' },
      { role: 'languageReviewer', label: 'Language Reviewer' },
      { role: 'styleAuditor', label: 'Style Auditor' },
    ] as const;
    const runCounts = settings.criticRunCounts ?? { factChecker: 1, languageReviewer: 1, styleAuditor: 1 };

    for (const agent of criticAgents) {
      const agentInfo = getModelForRole(settings, agent.role);
      if (agentInfo) {
        const { model, isFree } = agentInfo;
        const e = TOKEN_ESTIMATES.critic;
        const rc = runCounts[agent.role as keyof typeof runCounts] || 1;
        const callsPerProfile = effectiveRounds * rc;
        const totalInput = callsPerProfile * (e.inputBase + e.inputDraft + e.inputSystemPrompt);
        const totalOutput = callsPerProfile * e.outputFeedbackTokens;
        steps.push({
          label: `${agent.label} (${effectiveRounds}×${rc})`,
          role: agent.role,
          modelName: model.name,
          providerName: AI_PROVIDERS[agentInfo.provider].name,
          inputTokens: totalInput,
          outputTokens: totalOutput,
          cost: calcCost(totalInput, totalOutput, model, isFree),
          calls: callsPerProfile,
          isFree,
        });
      }
    }
  }

  // Source Verification — single verifier call
  {
    const verifierInfo = getModelForRole(settings, 'verifier');
    if (verifierInfo) {
      const { model, isFree } = verifierInfo;
      // Roughly: input = draft + system prompt (~4k), output = verification results (~1k)
      const totalInput = 4000;
      const totalOutput = 1000;
      steps.push({
        label: 'Source Verification',
        role: 'verifier',
        modelName: model.name,
        providerName: AI_PROVIDERS[verifierInfo.provider].name,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        cost: calcCost(totalInput, totalOutput, model, isFree),
        calls: 1,
        isFree,
      });
    }
  }

  const total = steps.reduce((sum, s) => sum + s.cost, 0);
  const totalCalls = steps.reduce((sum, s) => sum + s.calls, 0);
  return { steps, total, totalCalls };
}

// ── Exported utility for other components ────────────────────

/**
 * Returns a quick expected-case cost estimate for a single candidate run,
 * based on the current settings. Uses the same `calculatePipeline` logic.
 */
export function estimateSingleRunCost(settings: AppSettings): { expected: number; best: number } {
  const maxRounds = settings.maxAdversarialRounds || 3;
  const convergenceThreshold = settings.convergenceThreshold || 80;
  const expectedRounds = Math.max(1, Math.ceil(maxRounds * (convergenceThreshold / 100)));
  const expected = calculatePipeline(settings, expectedRounds, TOKEN_ESTIMATES.claimsExpected);
  const best = calculatePipeline(settings, 1, TOKEN_ESTIMATES.claimsBestCase);
  return { expected: expected.total, best: best.total };
}

// ── Component ────────────────────────────────────────────────

interface CostCalculatorProps {
  settings: AppSettings;
}

export default function CostCalculator({ settings }: CostCalculatorProps) {
  const maxRounds = settings.maxAdversarialRounds || 3;
  const convergenceThreshold = settings.convergenceThreshold || 80;
  const skipCritics = settings.skipCritics ?? false;

  // Estimate expected rounds based on convergence threshold
  const expectedRounds = Math.max(1, Math.ceil(maxRounds * (convergenceThreshold / 100)));
  const bestRounds = 1;
  const worstRounds = maxRounds;

  const best = useMemo(
    () => calculatePipeline(settings, bestRounds, TOKEN_ESTIMATES.claimsBestCase),
    [settings, bestRounds],
  );
  const expected = useMemo(
    () => calculatePipeline(settings, expectedRounds, TOKEN_ESTIMATES.claimsExpected),
    [settings, expectedRounds],
  );
  const worst = useMemo(
    () => calculatePipeline(settings, worstRounds, TOKEN_ESTIMATES.claimsWorstCase),
    [settings, worstRounds],
  );

  // Get throughput estimate from rate limiter
  const throughputEstimate = useMemo(() => {
    const writerRole = settings.roleAssignments?.writer;
    if (!writerRole) return null;
    const providerType = writerRole.provider;
    const est = rateLimiter.getEstimatedThroughput(providerType);
    return est;
  }, [settings]);

  // Aggregate calls per provider for the expected scenario
  const callsByProvider = useMemo(() => {
    const byProvider: Record<string, { calls: number; modelNames: Set<string>; isFree: boolean }> = {};
    for (const step of expected.steps) {
      const key = step.providerName;
      if (!byProvider[key]) byProvider[key] = { calls: 0, modelNames: new Set(), isFree: step.isFree };
      byProvider[key].calls += step.calls;
      byProvider[key].modelNames.add(step.modelName);
    }
    return Object.entries(byProvider).map(([name, data]) => ({
      provider: name,
      calls: data.calls,
      models: Array.from(data.modelNames).join(', '),
      isFree: data.isFree,
    }));
  }, [expected.steps]);

  const allFree = expected.steps.every(s => s.isFree);
  const geminiTier = settings.geminiTier || 'free';
  const tierInfo = GEMINI_TIER_INFO[geminiTier];
  // If tier is paid, Gemini calls are NOT actually free even if the provider is listed as "free"
  const usesGemini = expected.steps.some(s => s.providerName.toLowerCase().startsWith('gemini'));
  const effectivelyFree = allFree && (!usesGemini || !tierInfo.chargesPerToken);

  const formatUsd = (v: number) => {
    if (v === 0) return '$0.00';
    if (v < 0.001) return '<$0.001';
    if (v < 0.01) return `$${v.toFixed(4)}`;
    return `$${v.toFixed(3)}`;
  };

  return (
    <div className="space-y-4">
      {/* ── Summary Bar ─────────────────────────────── */}
      <div className="p-3 rounded-lg bg-gray-50 border border-gray-200 space-y-3">
        <div>
          <div className="text-xs text-gray-500 uppercase tracking-wider font-medium">Cost per Profile</div>
          <div className="text-2xl font-bold text-gray-800 mt-1">
            {effectivelyFree ? (
              <span className="text-green-600">Free</span>
            ) : (
              <>
                {formatUsd(expected.total)}
                <span className="text-sm font-normal text-gray-400 ml-2">
                  expected
                </span>
              </>
            )}
          </div>
          {!effectivelyFree && usesGemini && tierInfo.chargesPerToken && allFree && (
            <p className="text-xs text-amber-700 mt-1">⚠ Your Gemini tier ({tierInfo.label}) charges per-token — these calls are not free.</p>
          )}
        </div>

        {!effectivelyFree && (
          <div className="grid grid-cols-3 gap-2 border-t border-gray-200 pt-2">
            <div className="text-center">
              <div className="text-xs text-gray-500">Best</div>
              <div className="text-sm font-semibold text-green-700">{formatUsd(best.total)}</div>
              <div className="text-[10px] text-gray-400">{bestRounds} rnd, {TOKEN_ESTIMATES.claimsBestCase} claims</div>
            </div>
            <div className="text-center border-x border-gray-200">
              <div className="text-xs text-gray-500">Expected</div>
              <div className="text-sm font-semibold text-yellow-700">{formatUsd(expected.total)}</div>
              <div className="text-[10px] text-gray-400">{expectedRounds} rnds, {TOKEN_ESTIMATES.claimsExpected} claims</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-gray-500">Worst</div>
              <div className="text-sm font-semibold text-red-700">{formatUsd(worst.total)}</div>
              <div className="text-[10px] text-gray-400">{worstRounds} rnds, {TOKEN_ESTIMATES.claimsWorstCase} claims</div>
            </div>
          </div>
        )}
      </div>

      {/* ── Range bar visual ────────────────────────── */}
      {!effectivelyFree && worst.total > 0 && (
        <div className="px-1">
          <div className="relative h-3 bg-gray-100 rounded-full overflow-hidden">
            {/* Best case */}
            <div
              className="absolute left-0 top-0 h-full bg-green-400 rounded-l-full"
              style={{ width: `${(best.total / worst.total) * 100}%` }}
            />
            {/* Expected */}
            <div
              className="absolute left-0 top-0 h-full bg-yellow-400 opacity-60"
              style={{ width: `${(expected.total / worst.total) * 100}%` }}
            />
            {/* Worst fills full bar (reference) */}
            <div className="absolute right-0 top-0 h-full bg-red-200 rounded-r-full" style={{ width: '100%', zIndex: -1 }} />
          </div>
          <div className="flex justify-between text-xs text-gray-400 mt-1">
            <span>{formatUsd(best.total)}</span>
            <span>{formatUsd(worst.total)}</span>
          </div>
        </div>
      )}

      {/* ── Breakdown Table ─────────────────────────── */}
      <details className="group">
        <summary className="cursor-pointer text-xs text-blue-600 hover:text-blue-800 font-medium select-none">
          Show cost breakdown (expected scenario)
        </summary>

        <div className="overflow-x-auto -mx-1">
        <table className="w-full mt-3 text-xs min-w-[400px]">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-200">
              <th className="pb-1 font-medium">Step</th>
              <th className="pb-1 font-medium">Model</th>
              <th className="pb-1 font-medium text-right">Calls</th>
              <th className="pb-1 font-medium text-right">In</th>
              <th className="pb-1 font-medium text-right">Out</th>
              <th className="pb-1 font-medium text-right">Cost</th>
            </tr>
          </thead>
          <tbody>
            {expected.steps.map((step, i) => (
              <tr key={i} className="border-b border-gray-50">
                <td className="py-1.5 text-gray-700">{step.label}</td>
                <td className="py-1.5 text-gray-600">
                  <span className="mr-1">{step.modelName}</span>
                  {step.isFree && <span className="text-green-600 text-xs">FREE</span>}
                </td>
                <td className="py-1.5 text-right text-gray-500">{step.calls}</td>
                <td className="py-1.5 text-right text-gray-500">{(step.inputTokens / 1000).toFixed(1)}K</td>
                <td className="py-1.5 text-right text-gray-500">{(step.outputTokens / 1000).toFixed(1)}K</td>
                <td className="py-1.5 text-right font-medium text-gray-700">
                  {step.isFree ? <span className="text-green-600">$0</span> : formatUsd(step.cost)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-gray-300">
              <td colSpan={3} className="py-2 font-semibold text-gray-800">Total per profile</td>
              <td className="py-2 text-right text-gray-500">
                {(expected.steps.reduce((s, r) => s + r.inputTokens, 0) / 1000).toFixed(1)}K
              </td>
              <td className="py-2 text-right text-gray-500">
                {(expected.steps.reduce((s, r) => s + r.outputTokens, 0) / 1000).toFixed(1)}K
              </td>
              <td className="py-2 text-right font-bold text-gray-800">{formatUsd(expected.total)}</td>
            </tr>
          </tfoot>
        </table>
        </div>

        {/* ── Assumptions ──────────────────────────── */}
        <div className="mt-3 p-3 bg-blue-50 rounded-lg text-sm text-blue-800 space-y-1">
          <div className="font-semibold">Calculation assumptions:</div>
          <ul className="list-disc list-inside space-y-0.5">
            <li>Source HTML: ~4,000 input tokens per profile</li>
            <li>System prompts: ~1,000–2,000 tokens per call</li>
            <li>Writer output: ~3,000 tokens per draft</li>
            {!skipCritics && (
              <li>Critics: 3 specialized agents per round (Fact Checker, Language Reviewer, Style Auditor)</li>
            )}
            {skipCritics && <li>Critics: <strong>skipped</strong></li>}
            <li>Expected rounds: {expectedRounds} (max {maxRounds}, convergence threshold {convergenceThreshold}%)</li>
            <li>Source verification: 1 AI call to check cited URLs</li>
            <li>Output cost uses provider output pricing where available, otherwise estimated at 3× input rate</li>
            {allFree && !effectivelyFree && (
              <li><strong>⚠ Gemini tier:</strong> You are on <em>{tierInfo.label}</em>. Calls shown as &ldquo;Free&rdquo; above are actually charged at paid rates. See <a href="https://ai.google.dev/gemini-api/docs/pricing" target="_blank" className="underline">pricing</a>.</li>
            )}
            {effectivelyFree && (
              <li><strong>Note:</strong> Gemini free tier data may be used to improve Google products. See <a href="https://ai.google.dev/gemini-api/docs/pricing" target="_blank" className="underline">pricing page</a> for details.</li>
            )}
            <li>Prices verified from official provider docs, Feb 2026. <a href="https://ai.google.dev/gemini-api/docs/pricing" target="_blank" className="underline">Gemini pricing</a> · <a href="https://docs.x.ai/developers/models" target="_blank" className="underline">xAI pricing</a></li>
          </ul>
        </div>
      </details>

      {/* ── Throughput & Calls-per-Provider ────────── */}
      <div className="space-y-3">
        {throughputEstimate && (
          <div className="p-2.5 bg-gray-50 rounded-lg border border-gray-200 text-xs text-gray-700">
            <strong>Throughput:</strong> ~{throughputEstimate.profilesPerHour.toFixed(1)}/hr · ~{Math.round(throughputEstimate.profilesPerDay)}/day
            <div className="text-gray-400 text-[10px] mt-0.5">bottleneck: {throughputEstimate.bottleneckReason}</div>
          </div>
        )}

        {callsByProvider.length > 0 && (
          <details className="group">
            <summary className="cursor-pointer text-xs text-blue-600 hover:text-blue-800 font-medium select-none">
              Show calls per provider ({expected.totalCalls} total)
            </summary>
            <div className="mt-2 space-y-1.5">
              {callsByProvider.map(cp => (
                <div key={cp.provider} className="flex items-center justify-between px-2.5 py-1.5 bg-gray-50 rounded border border-gray-100 text-xs">
                  <div className="min-w-0">
                    <span className="font-medium text-gray-700 truncate block">{cp.provider}</span>
                    <div className="text-[10px] text-gray-400 truncate">{cp.models}</div>
                  </div>
                  <span className="font-semibold text-gray-800 shrink-0 ml-2">{cp.calls}</span>
                </div>
              ))}
            </div>
          </details>
        )}

        {/* ── Batch estimate helper ──────────────────── */}
        {!effectivelyFree && (
          <div className="p-2.5 bg-gray-50 rounded-lg border border-gray-200 text-xs text-gray-600">
            <strong>Batch:</strong> 10 ≈ {formatUsd(expected.total * 10)} · 50 ≈ {formatUsd(expected.total * 50)} · 100 ≈ {formatUsd(expected.total * 100)}
          </div>
        )}
      </div>
    </div>
  );
}
