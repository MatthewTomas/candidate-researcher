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
import { AI_PROVIDERS, PIPELINE_MODE_INFO, GEMINI_TIER_INFO, type AIProviderType, type AppSettings, type RoleAssignment, type ModelInfo, type PipelineMode } from '../types';
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

function getModelForRole(
  settings: AppSettings,
  role: string,
): { provider: AIProviderType; model: ModelInfo } | null {
  const assignment = role === 'verifier'
    ? settings.roleAssignments?.verifiers?.[0]
    : (settings.roleAssignments as any)?.[role] as RoleAssignment | undefined;

  if (!assignment) return null;

  const providerConfig = AI_PROVIDERS[assignment.provider];
  if (!providerConfig) return null;

  const modelId = assignment.model || providerConfig.defaultModel;
  const model = providerConfig.models.find(m => m.id === modelId) || providerConfig.models[0];

  return { provider: assignment.provider, model };
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
  pipelineMode: PipelineMode,
): { steps: PipelineStepCost[]; total: number; totalCalls: number } {
  const steps: PipelineStepCost[] = [];

  const skipCritics = pipelineMode === 'draft';
  const combinedCritic = settings.criticMode === 'combined' || pipelineMode === 'fast';
  const skipAudit = pipelineMode === 'draft';
  const singleVerifier = settings.auditMode === 'single-verifier' || pipelineMode === 'fast';

  // Adjust rounds by pipeline mode
  const effectiveRounds =
    pipelineMode === 'thorough' ? rounds :
    pipelineMode === 'balanced' ? Math.min(rounds, 2) :
    1; // fast / draft

  // Writer
  const writerInfo = getModelForRole(settings, 'writer');
  if (writerInfo) {
    const { model } = writerInfo;
    const isFree = AI_PROVIDERS[writerInfo.provider].isFree;
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

  // Critics — skip in draft mode, use combined in combined/fast modes
  if (!skipCritics) {
    if (combinedCritic) {
      // Combined critic: single call per round covering all 3 domains
      const criticInfo = getModelForRole(settings, 'factChecker') || getModelForRole(settings, 'critic');
      if (criticInfo) {
        const { model } = criticInfo;
        const isFree = AI_PROVIDERS[criticInfo.provider].isFree;
        const e = TOKEN_ESTIMATES.critic;
        const totalInput = effectiveRounds * (e.inputBase + e.inputDraft + e.inputSystemPrompt * 1.5); // larger combined prompt
        const totalOutput = effectiveRounds * (e.outputFeedbackTokens * 1.5); // combined output slightly larger
        steps.push({
          label: `Combined Critic (${effectiveRounds} round${effectiveRounds > 1 ? 's' : ''})`,
          role: 'critic-combined',
          modelName: model.name,
          providerName: AI_PROVIDERS[criticInfo.provider].name,
          inputTokens: totalInput,
          outputTokens: totalOutput,
          cost: calcCost(totalInput, totalOutput, model, isFree),
          calls: effectiveRounds,
          isFree,
        });
      }
    } else {
      // Specialized Critics (3 agents, each with configurable run counts)
      const criticAgents = [
        { role: 'factChecker', label: 'Fact Checker' },
        { role: 'languageReviewer', label: 'Language Reviewer' },
        { role: 'styleAuditor', label: 'Style Auditor' },
      ] as const;
      const runCounts = settings.criticRunCounts ?? { factChecker: 1, languageReviewer: 1, styleAuditor: 1 };

      for (const agent of criticAgents) {
        const agentInfo = getModelForRole(settings, agent.role) || getModelForRole(settings, 'critic');
        if (agentInfo) {
          const { model } = agentInfo;
          const isFree = AI_PROVIDERS[agentInfo.provider].isFree;
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
  }

  // Claim Extractor — skipped in draft mode
  if (!skipAudit) {
    const extractorInfo = getModelForRole(settings, 'extractor');
    if (extractorInfo) {
      const { model } = extractorInfo;
      const isFree = AI_PROVIDERS[extractorInfo.provider].isFree;
      const e = TOKEN_ESTIMATES.extractor;
      const totalInput = e.inputDraft + e.inputSystemPrompt;
      const totalOutput = e.outputClaimsTokens;
      steps.push({
        label: 'Claim Extractor',
        role: 'extractor',
        modelName: model.name,
        providerName: AI_PROVIDERS[extractorInfo.provider].name,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        cost: calcCost(totalInput, totalOutput, model, isFree),
        calls: 1,
        isFree,
      });
    }
  }

  // Verifiers — skipped in draft mode, limited to 1 in single-verifier mode
  if (!skipAudit) {
    const verifiers = settings.roleAssignments?.verifiers || [];
    const configuredVerifiers = Math.max(1, verifiers.length);
    const numVerifiers = singleVerifier ? 1 : configuredVerifiers;
    const verifierInfo = getModelForRole(settings, 'verifier');
    if (verifierInfo) {
      const { model } = verifierInfo;
      const isFree = AI_PROVIDERS[verifierInfo.provider].isFree;
      const e = TOKEN_ESTIMATES.verifier;
      const callsTotal = claims * numVerifiers;
      const totalInput = callsTotal * (e.inputClaimContext + e.inputSourceContext + e.inputSystemPrompt);
      const totalOutput = callsTotal * e.outputVerdictTokens;
      steps.push({
        label: `Verifiers (${claims} claims × ${numVerifiers} verifier${numVerifiers > 1 ? 's' : ''})${singleVerifier ? ' [single]' : ''}`,
        role: 'verifier',
        modelName: model.name,
        providerName: AI_PROVIDERS[verifierInfo.provider].name,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        cost: calcCost(totalInput, totalOutput, model, isFree),
        calls: callsTotal,
        isFree,
      });
    }
  }

  const total = steps.reduce((sum, s) => sum + s.cost, 0);
  const totalCalls = steps.reduce((sum, s) => sum + s.calls, 0);
  return { steps, total, totalCalls };
}

// ── Component ────────────────────────────────────────────────

interface CostCalculatorProps {
  settings: AppSettings;
}

export default function CostCalculator({ settings }: CostCalculatorProps) {
  const maxRounds = settings.maxAdversarialRounds || 3;
  const convergenceThreshold = settings.convergenceThreshold || 80;
  const pipelineMode: PipelineMode = settings.pipelineMode || 'balanced';
  const modeInfo = PIPELINE_MODE_INFO[pipelineMode];
  const skipCritics = pipelineMode === 'draft';
  const skipAudit = pipelineMode === 'draft';
  const singleVerifier = settings.auditMode === 'single-verifier' || pipelineMode === 'fast';

  // Estimate expected rounds based on convergence threshold
  // Higher threshold = more rounds needed = closer to maxRounds
  const expectedRounds = Math.max(1, Math.ceil(maxRounds * (convergenceThreshold / 100)));
  const bestRounds = 1;
  const worstRounds = maxRounds;

  const best = useMemo(
    () => calculatePipeline(settings, bestRounds, TOKEN_ESTIMATES.claimsBestCase, pipelineMode),
    [settings, bestRounds, pipelineMode],
  );
  const expected = useMemo(
    () => calculatePipeline(settings, expectedRounds, TOKEN_ESTIMATES.claimsExpected, pipelineMode),
    [settings, expectedRounds, pipelineMode],
  );
  const worst = useMemo(
    () => calculatePipeline(settings, worstRounds, TOKEN_ESTIMATES.claimsWorstCase, pipelineMode),
    [settings, worstRounds, pipelineMode],
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
      {/* ── Pipeline Mode Badge ──────────────────────── */}
      <div className="flex items-center gap-3 p-3 rounded-lg bg-blue-50 border border-blue-200">
        <div className="flex items-center gap-2 flex-1">
          <span className="text-sm font-semibold text-blue-800">{modeInfo.label} Mode</span>
          <span className="text-xs text-blue-600">{modeInfo.description}</span>
        </div>
        <div className="text-right text-xs text-blue-700">
          <span className="font-semibold">{expected.totalCalls}</span> API calls/profile
        </div>
      </div>

      {/* ── Summary Bar ─────────────────────────────── */}
      <div className="flex items-center gap-6 p-4 rounded-lg bg-gray-50 border border-gray-200">
        <div className="flex-1">
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
            <p className="text-[10px] text-amber-700 mt-1">⚠ Your Gemini tier ({tierInfo.label}) charges per-token — these calls are not free.</p>
          )}
        </div>

        {!effectivelyFree && (
          <>
            <div className="text-center border-l border-gray-200 pl-6">
              <div className="text-xs text-gray-500">Best Case</div>
              <div className="text-sm font-semibold text-green-700">{formatUsd(best.total)}</div>
              <div className="text-[10px] text-gray-400">{bestRounds} round, {TOKEN_ESTIMATES.claimsBestCase} claims</div>
            </div>
            <div className="text-center border-l border-gray-200 pl-6">
              <div className="text-xs text-gray-500">Expected</div>
              <div className="text-sm font-semibold text-yellow-700">{formatUsd(expected.total)}</div>
              <div className="text-[10px] text-gray-400">{expectedRounds} rounds, {TOKEN_ESTIMATES.claimsExpected} claims</div>
            </div>
            <div className="text-center border-l border-gray-200 pl-6">
              <div className="text-xs text-gray-500">Worst Case</div>
              <div className="text-sm font-semibold text-red-700">{formatUsd(worst.total)}</div>
              <div className="text-[10px] text-gray-400">{worstRounds} rounds, {TOKEN_ESTIMATES.claimsWorstCase} claims</div>
            </div>
          </>
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
          <div className="flex justify-between text-[10px] text-gray-400 mt-1">
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

        <table className="w-full mt-3 text-xs">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-200">
              <th className="pb-1 font-medium">Pipeline Step</th>
              <th className="pb-1 font-medium">Model</th>
              <th className="pb-1 font-medium text-right">Calls</th>
              <th className="pb-1 font-medium text-right">Input</th>
              <th className="pb-1 font-medium text-right">Output</th>
              <th className="pb-1 font-medium text-right">Cost</th>
            </tr>
          </thead>
          <tbody>
            {expected.steps.map((step, i) => (
              <tr key={i} className="border-b border-gray-50">
                <td className="py-1.5 text-gray-700">{step.label}</td>
                <td className="py-1.5 text-gray-600">
                  <span className="mr-1">{step.modelName}</span>
                  {step.isFree && <span className="text-green-600 text-[10px]">FREE</span>}
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

        {/* ── Assumptions ──────────────────────────── */}
        <div className="mt-3 p-3 bg-blue-50 rounded-lg text-[11px] text-blue-800 space-y-1">
          <div className="font-semibold">Calculation assumptions:</div>
          <ul className="list-disc list-inside space-y-0.5">
            <li>Pipeline mode: <strong>{modeInfo.label}</strong> — {modeInfo.description}</li>
            <li>Source HTML: ~4,000 input tokens per profile</li>
            <li>System prompts: ~1,000–2,000 tokens per call</li>
            <li>Writer output: ~3,000 tokens per draft</li>
            {!skipCritics && (
              <li>Critic mode: {settings.criticMode === 'combined' || pipelineMode === 'fast' ? 'Combined (1 call/round)' : 'Specialized (3 agents/round)'}</li>
            )}
            {skipCritics && <li>Critics: <strong>skipped</strong> (draft mode)</li>}
            <li>Expected rounds: {expectedRounds} (max {maxRounds}, convergence threshold {convergenceThreshold}%)</li>
            <li>Expected claims: ~{TOKEN_ESTIMATES.claimsExpected} per profile</li>
            {!skipAudit && (
              <li>Verifiers: {singleVerifier ? '1 (single-verifier mode)' : `${settings.roleAssignments?.verifiers?.length || 1} configured`}</li>
            )}
            {skipAudit && <li>Audit: <strong>skipped</strong> (draft mode)</li>}
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
          <div className="flex items-center gap-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
            <div className="text-xs text-gray-700">
              <strong>Throughput estimate:</strong>{' '}
              ~{throughputEstimate.profilesPerHour.toFixed(1)} profiles/hr ·{' '}
              ~{Math.round(throughputEstimate.profilesPerDay)} profiles/day
              <span className="text-gray-400 ml-2">
                (bottleneck: {throughputEstimate.bottleneckReason})
              </span>
            </div>
          </div>
        )}

        {callsByProvider.length > 0 && (
          <details className="group">
            <summary className="cursor-pointer text-xs text-blue-600 hover:text-blue-800 font-medium select-none">
              Show calls per provider ({expected.totalCalls} total calls)
            </summary>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {callsByProvider.map(cp => (
                <div key={cp.provider} className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded border border-gray-100 text-xs">
                  <div>
                    <span className="font-medium text-gray-700">{cp.provider}</span>
                    {cp.isFree && <span className="ml-1 text-green-600 text-[10px]">FREE</span>}
                    <div className="text-[10px] text-gray-400">{cp.models}</div>
                  </div>
                  <span className="font-semibold text-gray-800">{cp.calls} calls</span>
                </div>
              ))}
            </div>
          </details>
        )}

        {/* ── Batch estimate helper ──────────────────── */}
        {!effectivelyFree && (
          <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg border border-gray-200">
            <div className="text-xs text-gray-600">
              <strong>Batch estimate:</strong>{' '}
              10 profiles ≈ {formatUsd(expected.total * 10)} ·{' '}
              50 profiles ≈ {formatUsd(expected.total * 50)} ·{' '}
              100 profiles ≈ {formatUsd(expected.total * 100)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
