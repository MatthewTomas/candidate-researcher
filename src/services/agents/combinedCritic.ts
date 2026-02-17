/**
 * Combined Critic Agent — merges fact-checking, language review, and style
 * auditing into a single AI call. Used in 'balanced' and 'fast' pipeline
 * modes to reduce API calls from 3 to 1 per critic round.
 *
 * The prompt is carefully constructed to cover all three review domains while
 * maintaining the same output format as the specialized agents.
 */

import type { AIProvider } from '../aiProvider';
import type { StagingDraft, CriticFeedback, CriticIssue } from '../../types';
import { computeScore } from '../scoring';

const COMBINED_CRITIC_SYSTEM_PROMPT = `You are a comprehensive reviewer for Branch Politics candidate profiles. You perform THREE review functions in a single pass:

═══ 1. FACTUAL ACCURACY ═══
Check for:
- factual-error — A claim does not match its cited source, a quote is fabricated, or a fact is incorrect.
- missing-source — A factual claim has no SOURCE URL or SUPPORTING QUOTE. Every claim MUST have both.
- identity-mismatch — A source is about a DIFFERENT person with a similar name.
- unsupported-claim — A statement that cannot be verified from the provided source material.
- fabricated-source — A URL that does NOT appear in the original source material. The Writer invented it. This is the MOST SERIOUS issue.

SOURCE RULES:
- NEVER allow BallotReady, VoteSmart, or Wikipedia as sources.
- Every supporting quote must be CMD+F searchable on the source page.
- Broad accomplishment claims without specific bill/vote references should be flagged.
- ANY URL not present in the source material is FABRICATED and must be flagged with severity "fabrication".
- You earn bonus points for identifying fabricated sources. A fabrication catches a hallucination.

═══ 2. NONPARTISAN LANGUAGE ═══
Check for:
- language-bias — Any partisan, loaded, or biased language.

SUBSTITUTION CHART (enforce strictly):
| NEVER use | ALWAYS say instead |
|---|---|
| Pro-choice, pro-life, abortion rights | "Supports/Opposes abortion access" |
| Global Warming, Climate Crisis | "Climate change" / "supports policies that address climate change" |
| Second Amendment rights, gun rights, pro-gun, anti-gun | "Supports/Opposes gun control" |
| Critical Race Theory (CRT) | "Education on race and racism" |
| Securing the border, Illegal immigration, illegals | "Reduce immigration" / "undocumented immigrants" |
| America first | "Opposes intervention in international conflicts and prioritizes domestic policy" |

- Do NOT use "Claims" as a stance verb (implies doubt).
- Convert unverifiable accomplishment claims to policy positions.

═══ 3. TEMPLATE & STYLE ═══
Check for:
- template-violation — Any deviation from structural or formatting rules.
- style — Style improvements.

KEY RULES:
- Full name on first mention only (Personal Background), first name after.
- Lowercase degrees: "bachelor's degree", "law degree" (never "Juris Doctorate").
- Personal: origin → education → family/location. Include number of children (not names).
- Professional: current job first. NO dates, NO role descriptions.
- Political: reverse chronological. Only elected positions.
- Stances: varied action verbs (Said, Supports, Advocates, Opposes, Believes, Plans). Unbundle compound stances. No redundancy.
- Numbers 1–10 spelled out, 11+ numerals. Districts always numerals.
- No contractions. Only proper nouns capitalized.

SEVERITY LEVELS:
- fabrication: URL not in source material (MOST SEVERE — penalty: -50 points each)
- critical: Factual error, identity mismatch, fabricated quote
- major: Missing source, wrong person cited, biased language from substitution chart, significant template violation
- minor: Suboptimal source, subtle bias, minor formatting issue
- suggestion: Better source available, style improvement`;

export interface CombinedCriticInput {
  candidateName: string;
  draft: Partial<StagingDraft>;
  sourceContent: string;
  /** Provenance results injected by the pipeline — tells the critic which URLs are fabricated */
  provenanceContext?: string;
}

export async function runCombinedCritic(
  provider: AIProvider,
  input: CombinedCriticInput,
): Promise<CriticFeedback> {
  const provenanceSection = input.provenanceContext
    ? `\n\n${input.provenanceContext}`
    : '';

  const prompt = `Review this candidate profile for "${input.candidateName}" — check ALL THREE areas: factual accuracy, nonpartisan language, and template/style compliance.

PROFILE TO REVIEW:
${JSON.stringify(input.draft, null, 2)}

ORIGINAL SOURCE MATERIAL:
${input.sourceContent}
${provenanceSection}

For each issue found, provide:
- id: unique identifier (e.g., "combined-1", "combined-2")
- severity: "fabrication" | "critical" | "major" | "minor" | "suggestion"
- category: use "fabricated-source" | "factual-error" | "missing-source" | "identity-mismatch" | "unsupported-claim" | "language-bias" | "template-violation" | "style"
- section: which part of the profile (e.g., "bio-personal", "issue-public-safety", "stance-3")
- description: what's wrong
- suggestion: how to fix it
- resolved: false

IMPORTANT: If FABRICATED SOURCES are listed above, you MUST flag each one with severity "fabrication" and category "fabricated-source". These are URLs the Writer invented — they do not exist in the source material.

Be thorough across all three domains. Check every claim, every stance, every formatting rule.

Return JSON:
{
  "issues": [...],
  "overallAssessment": "comprehensive summary covering accuracy, language, and style",
  "overallScore": 0 to 100,
  "templateComplianceScore": 0 to 100
}`;

  const raw = await provider.generateJSON<CriticFeedback>(prompt, {
    systemPrompt: COMBINED_CRITIC_SYSTEM_PROMPT,
    temperature: 0.15,
    maxTokens: 6144,
  });

  // Validate/sanitize
  const issues: CriticIssue[] = Array.isArray(raw.issues)
    ? raw.issues.map(issue => ({ ...issue, resolved: false }))
    : [];

  const result: CriticFeedback = {
    issues,
    overallAssessment: raw.overallAssessment || '',
    // Use deterministic scoring from actual issues, not AI-reported score
    overallScore: computeScore(issues),
    templateComplianceScore: typeof raw.templateComplianceScore === 'number' ? raw.templateComplianceScore : 0,
  };

  return result;
}
