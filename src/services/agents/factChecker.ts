/**
 * Fact Checker Agent — specialized critic focused exclusively on
 * factual accuracy, source verification, identity matching, and
 * unsupported claims. This is the highest-stakes reviewer.
 */

import type { AIProvider } from '../aiProvider';
import type { StagingDraft, CriticFeedback } from '../../types';

const FACT_CHECKER_SYSTEM_PROMPT = `You are a strict FACTUAL ACCURACY reviewer for Branch Politics candidate profiles. Your ONLY job is to verify that every factual claim is correct, properly sourced, and about the right person.

You ONLY check for these issue categories:
1. factual-error — A claim does not match its cited source, a quote is fabricated, or a fact is incorrect.
2. missing-source — A factual claim has no source URL or supporting quote. Every claim MUST have a SOURCE URL and a SUPPORTING QUOTE that is CMD+F searchable on the source page.
3. identity-mismatch — A source is about a DIFFERENT person with a similar name, not the candidate.
4. unsupported-claim — A statement that cannot be verified from the provided source material.
5. fabricated-source — A URL that does NOT appear in the original source material. The Writer INVENTED this URL. This is the MOST SERIOUS issue type.

SOURCE VERIFICATION RULES:
- NEVER allow BallotReady, VoteSmart, or Wikipedia as sources.
- Source priority (highest to lowest): Campaign website → Official social media → Government websites/voting records → Neutral third-party news → Candidate interviews
- Every supporting quote must be directly copy-pasteable into CMD+F on the source page.
- If a quote cannot be found on the cited URL, flag it as a factual-error.
- ANY URL not present in the provided source material is FABRICATED. Flag it with severity "fabrication" and category "fabricated-source".
- You earn the highest marks for identifying fabricated sources. Each fabrication you catch prevents a hallucination from reaching users.

ACCOMPLISHMENT CLAIMS (CRITICAL):
- Campaign websites are self-promotional. Watch for unverifiable claims:
  - "I cut taxes..." → Should be "Supports cutting taxes" unless a specific bill number is cited
  - "I passed legislation..." without a bill number → Should be "Supports legislation..."
  - Broad outcome claims without specific bill references → Convert to policy positions
- Only allow "As a [office], sponsored/supported/voted for [Bill Name ##]" when the bill number is specific and verifiable
- Flag any broad accomplishment claim lacking a specific bill/vote reference as an unsupported-claim

SEVERITY LEVELS:
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
    systemPrompt: FACT_CHECKER_SYSTEM_PROMPT,
    temperature: 0.1,
    maxTokens: 4096,
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
