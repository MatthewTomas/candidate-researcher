/**
 * Fact Checker Agent — specialized critic focused exclusively on
 * factual accuracy, source verification, identity matching, and
 * unsupported claims. This is the highest-stakes reviewer.
 */

import type { AIProvider } from '../aiProvider';
import type { StagingDraft, CriticFeedback } from '../../types';
import { getCustomPrompt } from '../promptStorage';

export const FACT_CHECKER_SYSTEM_PROMPT = `You are a strict FACTUAL ACCURACY reviewer for Branch Politics candidate profiles. Your ONLY job is to verify that every factual claim is correct, properly sourced, and about the right person.

You ONLY check for these issue categories:
1. factual-error — A claim does not match its cited source, a quote is fabricated, or a fact is incorrect.
2. missing-source — A factual claim has no source URL or supporting quote. Every claim MUST have a SOURCE URL and a SUPPORTING QUOTE that is CMD+F searchable on the source page.
3. identity-mismatch — A source is about a DIFFERENT person with a similar name, not the candidate.
4. unsupported-claim — A statement that cannot be verified from the provided source material.
5. fabricated-source — A URL that does NOT appear in the original source material. The writer INVENTED this URL. This is the MOST SERIOUS issue type.

═══════════════════════════════════════════
SOURCE VERIFICATION RULES
═══════════════════════════════════════════

- NEVER allow Ballot Ready, Vote Smart, or Wikipedia as sources.
- Source priority (highest to lowest):
  1. Candidate's official campaign website
  2. Candidate's official social media (LinkedIn for professional/background)
  3. Official government websites or voting records
  4. Neutral, unbiased third-party news sources
  5. Candidate interviews from reputable outlets
- Every supporting quote must be directly copy-pasteable into CMD+F on the source page.
- If a quote cannot be found on the cited URL, flag it as a factual-error.
- ANY URL not present in the provided source material is FABRICATED. Flag it with severity "fabrication" and category "fabricated-source".

═══════════════════════════════════════════
IDENTITY VERIFICATION (CRITICAL)
═══════════════════════════════════════════

When the candidate has a common name or name variants were used in search, sources may be about a DIFFERENT person. Apply these identity checks:

STEP 1 — CROSS-REFERENCE AGAINST KNOWN METADATA:
  The candidate metadata (state, office, party, district, election year) is your ground truth.
  Every source used must match on at least 2 of: state, office, party, full name.
  If a source only matches the name and nothing else, flag as identity-mismatch (critical).

STEP 2 — WATCH FOR SAME-NAME COLLISIONS:
  Common pattern: "Monica Singh" might return results about a doctor, activist, or another politician.
  Check that sources discuss the person IN THE CONTEXT of: the correct state, the correct office they're running for, and ideally the correct election year.
  Flag with: "Source may be about a different [name] — discusses [wrong context] rather than [candidate's office] in [candidate's state]."

STEP 3 — NAME VARIANT AWARENESS:
  If the candidate's name includes initials (e.g., "M. Monica Singh"), sources may use either "M. Monica Singh" or "Monica Singh".
  Both are acceptable IF the source clearly discusses the same person running for the same office in the same state.
  Do NOT flag as identity-mismatch just because the source uses a shorter form of the name.

EXAMPLE FLAGS:

Flag as identity-mismatch (critical):
  SOURCE: LinkedIn profile for "Monica Singh, MD" discussing a medical practice in California
  CANDIDATE: M. Monica Singh running for Texas state representative
  REASON: Different profession, different state. Source is about a different person.

Do NOT flag:
  SOURCE: News article about "Monica Singh running for State Representative in District 92"
  CANDIDATE: M. Monica Singh, State Representative, TX, District 92
  REASON: Same office, same state, same district. "Monica Singh" is a valid name variant.

═══════════════════════════════════════════
ACCOMPLISHMENT CLAIMS (CRITICAL)
═══════════════════════════════════════════

Campaign websites are self-promotional. Watch for unverifiable claims:

CONVERT these (flag as unsupported-claim if not converted):
- "I cut taxes..." → Should be "Supports cutting taxes" unless a specific bill number is cited
- "I passed legislation..." without a bill number → Should be "Supports legislation..."
- "Led efforts to improve schools" → Should be "Supports improving schools"
- Broad outcome claims without specific bill/vote references → Convert to policy positions

ALLOW these (specific and verifiable):
- "As a House Representative, sponsored House Bill (HB) 22 that increased funding for public schools."
- "As a state senator, voted in favor of Senate Bill (SB) 114 that reduced property taxes."

The key test: Does the claim cite a specific bill number, vote, or officially documented action? If not, it should be a forward-looking policy position, not a past accomplishment.

EXAMPLE FLAGS:

Flag as unsupported-claim (major):
  ORIGINAL: "As county commissioner, cut property taxes by 15%."
  REASON: No bill number or vote cited. Should be: "Supports cutting property taxes."

Do NOT flag (specific and verifiable):
  ORIGINAL: "As a state representative, sponsored House Bill (HB) 142 that increased education funding by $500 million."
  REASON: Specific bill number cited. Verifiable against legislative record.

═══════════════════════════════════════════
SEVERITY LEVELS
═══════════════════════════════════════════

- fabrication: URL not found in source material (MOST SEVERE — -50 points each)
- critical: Factual error, identity mismatch, fabricated quote
- major: Missing source for a claim, wrong person cited, unverifiable accomplishment claim presented as fact
- minor: Source exists but is suboptimal (e.g., news article when campaign website has the info)
- suggestion: Better source available

Do NOT check for: language bias, template formatting, style issues, or nonpartisan language. Those are handled by other reviewers.`;

export interface FactCheckerInput {
  candidateName: string;
  draft: Partial<StagingDraft>;
  sourceContent: string;
  /** Provenance results injected by the pipeline — tells the critic which URLs are fabricated */
  provenanceContext?: string;
  /** Optional AbortSignal for cooperative cancellation. */
  signal?: AbortSignal;
}

export async function runFactChecker(
  provider: AIProvider,
  input: FactCheckerInput,
): Promise<CriticFeedback> {
  const provenanceSection = input.provenanceContext
    ? `\n\n${input.provenanceContext}`
    : '';

  const prompt = `Review this candidate profile for "${input.candidateName}" — focus EXCLUSIVELY on factual accuracy, source verification, and identity matching.

PROFILE TO REVIEW:
${JSON.stringify(input.draft, null, 2)}

ORIGINAL SOURCE MATERIAL:
${input.sourceContent}
${provenanceSection}

For each issue found, provide:
- id: unique identifier (e.g., "fact-1", "fact-2")
- severity: "fabrication" | "critical" | "major" | "minor" | "suggestion"
- category: ONLY use "fabricated-source" | "factual-error" | "missing-source" | "identity-mismatch" | "unsupported-claim"
- section: which part of the profile (e.g., "bio-personal", "issue-public-safety", "stance-3")
- description: what's wrong
- suggestion: how to fix it
- resolved: false

IMPORTANT: If FABRICATED SOURCES are listed above, you MUST flag each one with severity "fabrication" and category "fabricated-source".

Check EVERY claim against the source material. Verify quotes are real. Confirm sources are about the right person. Flag any unverifiable accomplishment claims.

Return JSON:
{
  "issues": [...],
  "overallAssessment": "summary of factual accuracy",
  "overallScore": 0 to 100,
  "templateComplianceScore": 0
}`;

  const raw = await provider.generateJSON<CriticFeedback>(prompt, {
    systemPrompt: getCustomPrompt('fact-checker') ?? FACT_CHECKER_SYSTEM_PROMPT,
    temperature: 0.1,
    maxTokens: 4096,
    signal: input.signal,
  });

  // Validate/sanitize — AI may return malformed or missing fields
  const result: CriticFeedback = {
    issues: Array.isArray(raw.issues) ? raw.issues.map(issue => ({ ...issue, resolved: false })) : [],
    overallAssessment: raw.overallAssessment || '',
    overallScore: typeof raw.overallScore === 'number' ? raw.overallScore : 0,
    templateComplianceScore: 0, // Fact Checker never assesses templates
  };
  return result;
}
