/**
 * Claim Extractor — parses a profile to extract every verifiable claim.
 */

import type { AIProvider } from '../aiProvider';
import type { StagingDraft, ExtractedClaim } from '../../types';

export async function extractClaims(
  provider: AIProvider,
  draft: Partial<StagingDraft>,
  candidateName: string,
): Promise<ExtractedClaim[]> {
  const prompt = `Extract every factual claim from this candidate profile for "${candidateName}".

PROFILE:
${JSON.stringify(draft, null, 2)}

For each claim, extract:
- id: unique identifier (claim-1, claim-2, etc.)
- text: the factual claim being made
- sourceUrl: the cited source URL (if any)
- supportingQuote: the direct quote cited as evidence
- section: which section it's from (bio-personal, bio-professional, bio-political, or the issue key like "public-safety")
- category: the issue category or bio type
- claimType: "fact" (verifiable fact), "stance" (policy position), "background" (biographical), or "quote" (direct quote attribution)

Return JSON array:
[
  {
    "id": "claim-1",
    "text": "Oscar Salinas served as a prosecutor in Bexar County for over a decade",
    "sourceUrl": "https://...",
    "supportingQuote": "For over a decade, Oscar has served...",
    "section": "bio-professional",
    "category": "legal-experience",
    "claimType": "fact"
  }
]

Extract EVERY claim, including:
- Biographical facts (education, birthplace, family)
- Professional history claims
- Political history claims
- Policy stance claims
- Quoted statements attributed to the candidate
- Numeric claims (years, amounts, rankings)`;

  return provider.generateJSON<ExtractedClaim[]>(prompt, {
    temperature: 0.1,
    maxTokens: 8192,
  });
}
