/**
 * Verifier — independently verifies a single claim.
 * Each verifier produces its own assessment.
 */

import type { AIProvider } from '../aiProvider';
import type { ExtractedClaim, VerifierResult } from '../../types';
import { v4 as uuid } from 'uuid';

export async function verifyClaim(
  provider: AIProvider,
  claim: ExtractedClaim,
  candidateName: string,
): Promise<VerifierResult> {
  const groundingPrompt = `Verify the following claim about "${candidateName}".

CLAIM: "${claim.text}"
CITED SOURCE URL: ${claim.sourceUrl || 'none'}
SUPPORTING QUOTE: "${claim.supportingQuote || 'none'}"
CLAIM TYPE: ${claim.claimType}
SECTION: ${claim.section}

VERIFICATION TASKS:
1. IDENTITY CHECK: Is the source URL about "${candidateName}" specifically, or could it be about a different person? This is critical — many political candidates share common names.
2. FACTUAL CHECK: Based on your knowledge and any available information, is this claim accurate?
3. QUOTE CHECK: If a direct quote is cited, does it seem plausible and consistent with the source?
4. SOURCE QUALITY: Is the source URL from a reputable, non-prohibited source? (Prohibited: BallotReady, VoteSmart, Wikipedia)

RESPOND WITH JSON:
{
  "status": "verified" | "unverified" | "disputed" | "insufficient-evidence",
  "confidence": 0.0 to 1.0,
  "explanation": "detailed reasoning for your verdict, explaining what you checked and what you found",
  "identityCheck": true if the source appears to be about the correct person,
  "identityMismatch": true if the source is about a DIFFERENT person,
  "supportingEvidence": "what evidence supports or contradicts this claim"
}

Be honest about uncertainty. If you can't verify a claim, say "insufficient-evidence" rather than guessing. Explain your reasoning clearly — a human will read this.`;

  let responseText: string;

  // Use grounding if available (Gemini paid tier)
  if (provider.type === 'gemini-paid') {
    responseText = await provider.verifyWithGrounding(groundingPrompt, {
      temperature: 0.1,
      maxTokens: 2048,
      jsonMode: true,
    });
  } else {
    responseText = await provider.generateText(groundingPrompt, {
      temperature: 0.1,
      maxTokens: 2048,
    });
  }

  // Parse the response
  let parsed: {
    status: string;
    confidence: number;
    explanation: string;
    identityCheck: boolean;
    identityMismatch: boolean;
    supportingEvidence: string;
  };

  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    // If JSON parsing fails, create a result from the raw text
    parsed = {
      status: 'insufficient-evidence',
      confidence: 0.3,
      explanation: responseText.slice(0, 500),
      identityCheck: true,
      identityMismatch: false,
      supportingEvidence: 'Unable to parse structured response',
    };
  }

  return {
    verifierId: uuid(),
    providerUsed: provider.type,
    model: provider.model,
    verdict: parsed.status as VerifierResult['verdict'],
    confidence: Math.max(0, Math.min(1, parsed.confidence)),
    explanation: parsed.explanation,
    identityCheck: parsed.identityCheck,
    identityMismatch: parsed.identityMismatch,
    supportingEvidence: parsed.supportingEvidence,
    timestamp: new Date().toISOString(),
  };
}
