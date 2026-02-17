/**
 * Consensus Engine — aggregates results from multiple verifiers
 * and determines the overall status for each claim.
 */

import type { VerifierResult, ClaimAuditResult, VerificationVerdict, AuditReport } from '../../types';
import { v4 as uuid } from 'uuid';

/**
 * Determine consensus from multiple verifier results.
 * Returns a simplified consensus object.
 */
export function computeConsensus(
  results: VerifierResult[],
): { verdict: VerificationVerdict; confidence: number; explanation: string } {
  if (results.length === 0) {
    return {
      verdict: 'unverified',
      confidence: 0,
      explanation: 'No verifiers ran for this claim.',
    };
  }

  // Check for identity mismatch — any verifier flagging this is critical
  const identityMismatch = results.some(r => r.identityMismatch);
  if (identityMismatch) {
    return {
      verdict: 'contradicted',
      confidence: 0.9,
      explanation: `IDENTITY MISMATCH: One or more verifiers determined the source is about a different person. ${
        results.filter(r => r.identityMismatch).map(r => `[${r.providerUsed}]: ${r.explanation}`).join(' | ')
      }`,
    };
  }

  // Count votes
  const verdictCounts: Record<string, number> = {};
  let totalConfidence = 0;

  for (const r of results) {
    verdictCounts[r.verdict] = (verdictCounts[r.verdict] || 0) + 1;
    totalConfidence += r.confidence;
  }

  const avgConfidence = totalConfidence / results.length;

  // Determine consensus
  const sorted = Object.entries(verdictCounts).sort((a, b) => b[1] - a[1]);
  const topVerdict = sorted[0][0] as VerificationVerdict;
  const topCount = sorted[0][1];

  let verdict: VerificationVerdict;
  if (topCount === results.length) {
    verdict = topVerdict; // Unanimous
  } else if (topCount > results.length / 2) {
    verdict = topVerdict; // Majority
  } else {
    verdict = 'no-consensus';
  }

  // Build explanation
  const explanationParts = results.map(r =>
    `[${r.providerUsed}] ${r.verdict} (${(r.confidence * 100).toFixed(0)}%): ${r.explanation}`
  );

  const explanation = `Consensus: ${verdict} (${results.length} verifiers, ${topCount}/${results.length} agree). Avg confidence: ${(avgConfidence * 100).toFixed(0)}%.\n\n${explanationParts.join('\n\n')}`;

  return { verdict, confidence: avgConfidence, explanation };
}

/**
 * Build a complete audit report from claim results.
 */
export function buildAuditReport(
  results: ClaimAuditResult[],
  candidateName: string,
): AuditReport {
  const totalClaims = results.length;
  const verified = results.filter(r => r.consensus === 'verified').length;
  const contradicted = results.filter(r => r.consensus === 'contradicted').length;
  const unverified = results.filter(r => r.consensus === 'unverified' || r.consensus === 'no-consensus').length;
  const overallConfidence = totalClaims > 0
    ? results.reduce((sum, r) => sum + r.confidence, 0) / totalClaims
    : 0;

  return {
    id: uuid(),
    candidateName,
    timestamp: new Date().toISOString(),
    results,
    summary: {
      totalClaims,
      verified,
      contradicted,
      unverified,
      overallConfidence,
    },
  };
}
