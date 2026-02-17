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
