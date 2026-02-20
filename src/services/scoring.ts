/**
 * Deterministic Scoring Rubric — computes scores from actual issues found
 * instead of trusting AI-reported scores which can be hallucinated or undefined.
 *
 * Scoring model: Start at 100, deduct per severity.
 * - fabrication: −50 each (heaviest — fabricated sources destroy trust)
 * - critical:    −30 each
 * - major:       −15 each
 * - minor:        −5 each
 * - suggestion:   −2 each
 *
 * Floor is 0. This gives verifiable, testable, consistent scores.
 */

import type { CriticIssue } from '../types';

const SEVERITY_DEDUCTIONS: Record<string, number> = {
  fabrication: 50,
  critical: 30,
  major: 15,
  minor: 5,
  suggestion: 2,
};

/**
 * Compute a deterministic score from a list of issues.
 * Starts at 100, deducts per issue severity. Floor at 0.
 */
export function computeScore(issues: CriticIssue[]): number {
  let score = 100;
  for (const issue of issues) {
    score -= SEVERITY_DEDUCTIONS[issue.severity] ?? 0;
  }
  return Math.max(0, score);
}

/** Categories that belong to the factual-accuracy domain */
const FACT_CATEGORIES = new Set([
  'fabricated-source', 'factual-error', 'missing-source',
  'identity-mismatch', 'unsupported-claim',
]);
/** Categories that belong to the language domain */
const LANG_CATEGORIES = new Set(['language-bias']);
/** Categories that belong to the style/template domain */
const STYLE_CATEGORIES = new Set(['template-violation', 'style']);

// Scoring weights — same as criticOrchestrator
const FACT_WEIGHT = 0.50;
const LANG_WEIGHT = 0.25;
const STYLE_WEIGHT = 0.25;

/**
 * Compute a domain-partitioned weighted score from combined critic issues.
 * Splits issues into fact/language/style domains, scores each independently,
 * then applies the 50/25/25 weights. This prevents a single combined call
 * from generating so many cross-domain issues that the score floors at 0.
 */
export function computeCombinedScore(issues: CriticIssue[]): number {
  const factIssues: CriticIssue[] = [];
  const langIssues: CriticIssue[] = [];
  const styleIssues: CriticIssue[] = [];

  for (const issue of issues) {
    if (FACT_CATEGORIES.has(issue.category)) {
      factIssues.push(issue);
    } else if (LANG_CATEGORIES.has(issue.category)) {
      langIssues.push(issue);
    } else if (STYLE_CATEGORIES.has(issue.category)) {
      styleIssues.push(issue);
    } else {
      // Unknown category — assign to fact (most conservative)
      factIssues.push(issue);
    }
  }

  const factScore = computeScore(factIssues);
  const langScore = computeScore(langIssues);
  const styleScore = computeScore(styleIssues);

  return Math.round(factScore * FACT_WEIGHT + langScore * LANG_WEIGHT + styleScore * STYLE_WEIGHT);
}

/**
 * Compute template compliance score from only template/style issues.
 */
export function computeTemplateScore(issues: CriticIssue[]): number {
  const templateIssues = issues.filter(
    i => i.category === 'template-violation' || i.category === 'style',
  );
  return computeScore(templateIssues);
}

/**
 * Score for a failed agent — represents "unverified, cannot trust".
 */
export const FAILED_AGENT_SCORE = 0;
