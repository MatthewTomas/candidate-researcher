/**
 * Critic Orchestrator — coordinates the 3 specialized review agents
 * (Fact Checker, Language Reviewer, Style & Template Auditor) and
 * merges their feedback into a single CriticFeedback object.
 *
 * Supports parallel or sequential execution and configurable run counts.
 */

import type { AIProvider } from '../aiProvider';
import type { StagingDraft, CriticFeedback, CriticIssue, AppSettings, RoleAssignment, CriticMode } from '../../types';
import { runFactChecker } from './factChecker';
import { runLanguageReviewer } from './languageReviewer';
import { runStyleAuditor } from './styleAuditor';
import { runCombinedCritic } from './combinedCritic';
import { computeScore, computeTemplateScore, FAILED_AGENT_SCORE } from '../scoring';

// Scoring weights — accuracy is the most important thing
const FACT_CHECKER_WEIGHT = 0.50;
const LANGUAGE_REVIEWER_WEIGHT = 0.25;
const STYLE_AUDITOR_WEIGHT = 0.25;

export interface CriticAgentResult {
  agent: 'fact-checker' | 'language-reviewer' | 'style-auditor';
  label: string;
  feedback: CriticFeedback;
}

export interface OrchestratorInput {
  candidateName: string;
  draft: Partial<StagingDraft>;
  sourceContent: string;
  /** Formatted provenance check results — injected into critic prompts */
  provenanceContext?: string;
}

export interface OrchestratorProviders {
  factChecker: AIProvider;
  languageReviewer: AIProvider;
  styleAuditor: AIProvider;
}

export interface OrchestratorProgress {
  onAgentStart: (agent: string, pass: number, totalPasses: number) => void;
  onAgentComplete: (agent: string, pass: number, feedback: CriticFeedback) => void;
  onAgentRetry: (agent: string, attempt: number, maxAttempts: number, error: string, delaySec: number) => void;
}

const AGENT_RETRY_CONFIG = {
  maxAttempts: 5,
  baseDelayMs: 3000,
  maxDelayMs: 65000,
};

/** Sleep helper */
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Retry wrapper for individual agent calls.
 */
async function withAgentRetry<T>(
  agentName: string,
  fn: () => Promise<T>,
  progress?: OrchestratorProgress,
): Promise<T> {
  for (let attempt = 1; attempt <= AGENT_RETRY_CONFIG.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);
      const lower = msg.toLowerCase();
      // Only retry on parse errors, rate limits, network issues
      const isRetryable = lower.includes('json') || lower.includes('parse') ||
        lower.includes('429') || lower.includes('quota') || lower.includes('rate limit') ||
        lower.includes('fetch') || lower.includes('network') || lower.includes('timeout') ||
        lower.includes('unexpected token');

      if (!isRetryable || attempt >= AGENT_RETRY_CONFIG.maxAttempts) {
        throw err;
      }

      const isQuota = lower.includes('429') || lower.includes('quota') || lower.includes('rate limit');
      const delay = isQuota
        ? AGENT_RETRY_CONFIG.maxDelayMs
        : Math.min(AGENT_RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt - 1), AGENT_RETRY_CONFIG.maxDelayMs);
      const delaySec = Math.round(delay / 1000);

      progress?.onAgentRetry(agentName, attempt, AGENT_RETRY_CONFIG.maxAttempts, msg.slice(0, 100), delaySec);

      await sleep(delay);
    }
  }
  throw new Error(`${agentName} failed after ${AGENT_RETRY_CONFIG.maxAttempts} attempts`);
}

/**
 * Run one agent N times, deduplicating issues across passes.
 */
async function runAgentMultiple<T extends CriticFeedback>(
  runner: (provider: AIProvider, input: OrchestratorInput) => Promise<T>,
  provider: AIProvider,
  input: OrchestratorInput,
  runCount: number,
  agentName: string,
  progress?: OrchestratorProgress,
): Promise<T> {
  if (runCount <= 1) {
    progress?.onAgentStart(agentName, 1, 1);
    const result = await withAgentRetry(agentName, () => runner(provider, input), progress);
    progress?.onAgentComplete(agentName, 1, result);
    return result;
  }

  // Multiple passes — collect all issues, then deduplicate
  const allIssues: CriticIssue[] = [];
  let bestScore = 0;
  let bestAssessment = '';
  let bestTemplateScore = 0;

  for (let pass = 1; pass <= runCount; pass++) {
    progress?.onAgentStart(agentName, pass, runCount);
    const result = await withAgentRetry(agentName, () => runner(provider, input), progress);
    progress?.onAgentComplete(agentName, pass, result);

    allIssues.push(...result.issues);
    // Keep the most conservative (lowest) score across passes
    if (pass === 1 || result.overallScore < bestScore) {
      bestScore = result.overallScore;
      bestAssessment = result.overallAssessment;
      bestTemplateScore = result.templateComplianceScore;
    }
  }

  // Deduplicate issues by section + category + similar description
  const deduped = deduplicateIssues(allIssues);

  return {
    issues: deduped,
    overallAssessment: bestAssessment,
    overallScore: bestScore,
    templateComplianceScore: bestTemplateScore,
  } as T;
}

/**
 * Deduplicate issues by section + category, keeping the most severe.
 */
function deduplicateIssues(issues: CriticIssue[]): CriticIssue[] {
  const severityRank: Record<string, number> = { critical: 0, major: 1, minor: 2, suggestion: 3 };
  const seen = new Map<string, CriticIssue>();

  for (const issue of issues) {
    // Key: section + category + first 60 chars of description (normalized)
    const descKey = issue.description.toLowerCase().replace(/\s+/g, ' ').slice(0, 60);
    const key = `${issue.section}::${issue.category}::${descKey}`;

    const existing = seen.get(key);
    if (!existing || (severityRank[issue.severity] ?? 3) < (severityRank[existing.severity] ?? 3)) {
      seen.set(key, issue);
    }
  }

  return Array.from(seen.values());
}

/**
 * Run all 3 specialized critics (parallel or sequential) and merge results.
 * When criticMode is 'combined', runs a single combined critic call instead.
 */
export async function runSpecializedCritics(
  providers: OrchestratorProviders,
  input: OrchestratorInput,
  settings: AppSettings,
  progress?: OrchestratorProgress,
): Promise<{ merged: CriticFeedback; agentResults: CriticAgentResult[] }> {
  const criticMode: CriticMode = settings.criticMode ?? 'specialized';

  // ── Combined critic path — 1 API call instead of 3 ──
  if (criticMode === 'combined') {
    // Use the fact-checker provider for the combined call (it's the most important role)
    const provider = providers.factChecker;
    const agentName = 'Combined Critic';

    progress?.onAgentStart(agentName, 1, 1);
    try {
      const feedback = await withAgentRetry(
        agentName,
        () => runCombinedCritic(provider, { ...input, provenanceContext: input.provenanceContext }),
        progress,
      );
      progress?.onAgentComplete(agentName, 1, feedback);

      const agentResult: CriticAgentResult = {
        agent: 'fact-checker', // primary role
        label: agentName,
        feedback,
      };

      return { merged: feedback, agentResults: [agentResult] };
    } catch (err: any) {
      const errMsg = err instanceof Error ? err.message : String(err);
      progress?.onAgentRetry(agentName, AGENT_RETRY_CONFIG.maxAttempts, AGENT_RETRY_CONFIG.maxAttempts, `Failed permanently: ${errMsg.slice(0, 80)}`, 0);
      throw new Error(`Combined critic failed: ${errMsg}`);
    }
  }

  // ── Specialized critics path (original 3-agent approach) ──
  const runCounts = settings.criticRunCounts ?? { factChecker: 1, languageReviewer: 1, styleAuditor: 1 };
  const parallelism = settings.criticParallelism ?? 'parallel';

  const tasks = [
    {
      agent: 'fact-checker' as const,
      label: 'Fact Checker',
      runner: runFactChecker,
      provider: providers.factChecker,
      count: runCounts.factChecker,
    },
    {
      agent: 'language-reviewer' as const,
      label: 'Language Reviewer',
      runner: runLanguageReviewer,
      provider: providers.languageReviewer,
      count: runCounts.languageReviewer,
    },
    {
      agent: 'style-auditor' as const,
      label: 'Style & Template Auditor',
      runner: runStyleAuditor,
      provider: providers.styleAuditor,
      count: runCounts.styleAuditor,
    },
  ];

  const agentResults: CriticAgentResult[] = [];
  const failedAgentLabels: string[] = [];

  if (parallelism === 'parallel') {
    // Use allSettled so one agent failure doesn't kill the others
    const settled = await Promise.allSettled(
      tasks.map(async (task) => {
        const feedback = await runAgentMultiple(
          task.runner, task.provider, input, task.count, task.label, progress,
        );
        return { agent: task.agent, label: task.label, feedback };
      }),
    );

    const failures: string[] = [];
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      if (result.status === 'fulfilled') {
        agentResults.push(result.value);
      } else {
        const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
        failures.push(`${tasks[i].label}: ${errMsg.slice(0, 120)}`);
        failedAgentLabels.push(tasks[i].label);
        progress?.onAgentRetry(tasks[i].label, AGENT_RETRY_CONFIG.maxAttempts, AGENT_RETRY_CONFIG.maxAttempts, `Failed permanently: ${errMsg.slice(0, 80)}`, 0);
      }
    }

    // If ALL agents failed, throw so the outer retry can handle it
    if (agentResults.length === 0) {
      throw new Error(`All critic agents failed: ${failures.join('; ')}`);
    }
  } else {
    // Sequential — continue even if one agent fails
    const failures: string[] = [];
    for (const task of tasks) {
      try {
        const feedback = await runAgentMultiple(
          task.runner, task.provider, input, task.count, task.label, progress,
        );
        agentResults.push({ agent: task.agent, label: task.label, feedback });
      } catch (err: any) {
        const errMsg = err instanceof Error ? err.message : String(err);
        failures.push(`${task.label}: ${errMsg.slice(0, 120)}`);
        failedAgentLabels.push(task.label);
        progress?.onAgentRetry(task.label, AGENT_RETRY_CONFIG.maxAttempts, AGENT_RETRY_CONFIG.maxAttempts, `Failed permanently: ${errMsg.slice(0, 80)}`, 0);
      }
    }

    // If ALL agents failed, throw
    if (agentResults.length === 0) {
      throw new Error(`All critic agents failed: ${failures.join('; ')}`);
    }
  }

  // Merge all issues with deterministic scoring + track failed agents
  const merged = mergeResults(agentResults, failedAgentLabels);

  return { merged, agentResults };
}

/**
 * Merge 3 agents' feedback into one CriticFeedback.
 * Uses deterministic scoring from actual issues found.
 * Failed agents score 0 (unverified = cannot trust).
 * Weights: Fact Checker 50%, Language 25%, Style 25%.
 */
function mergeResults(results: CriticAgentResult[], failedAgents: string[]): CriticFeedback {
  const allIssues: CriticIssue[] = [];
  let issueCounter = 1;

  for (const { feedback } of results) {
    for (const issue of feedback.issues) {
      allIssues.push({
        ...issue,
        id: `issue-${issueCounter++}`,
      });
    }
  }

  const factResult = results.find(r => r.agent === 'fact-checker');
  const langResult = results.find(r => r.agent === 'language-reviewer');
  const styleResult = results.find(r => r.agent === 'style-auditor');

  // Deterministic scores from actual issues — failed agents get 0
  const factScore = factResult
    ? computeScore(factResult.feedback.issues)
    : FAILED_AGENT_SCORE;
  const langScore = langResult
    ? computeScore(langResult.feedback.issues)
    : FAILED_AGENT_SCORE;
  const styleScore = styleResult
    ? computeScore(styleResult.feedback.issues)
    : FAILED_AGENT_SCORE;

  const compositeScore = Math.round(
    factScore * FACT_CHECKER_WEIGHT +
    langScore * LANGUAGE_REVIEWER_WEIGHT +
    styleScore * STYLE_AUDITOR_WEIGHT,
  );

  const templateComplianceScore = styleResult
    ? computeTemplateScore(styleResult.feedback.issues)
    : 0;

  const assessments = results
    .map(r => `[${r.label}] ${r.feedback.overallAssessment}`)
    .filter(a => a.length > 0);

  return {
    issues: allIssues,
    overallAssessment: assessments.join(' | '),
    overallScore: compositeScore,
    templateComplianceScore,
    failedAgents: failedAgents.length > 0 ? failedAgents : undefined,
  };
}
