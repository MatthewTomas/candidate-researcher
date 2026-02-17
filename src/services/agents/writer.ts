/**
 * Writer Agent — generates a candidate profile from source material,
 * following the Candidate Profile Template rules.
 *
 * Uses chunked generation:
 *   Step 1: Generate bios (name, links, 3 bios) — ~3-5K tokens
 *   Step 2: Generate issues in batches of 4 — ~3-5K tokens each
 *   Step 3: Merge into one Partial<StagingDraft>
 *
 * When critic feedback is present, the prompt explicitly enumerates
 * each issue and requires the Writer to fix every one.
 */

import type { AIProvider } from '../aiProvider';
import type { StagingDraft, CriticFeedback, CriticIssue } from '../../types';

const TEMPLATE_SYSTEM_PROMPT = `You are a nonpartisan political researcher for Branch Politics. Your job is to write factual, sourced candidate profiles following strict editorial guidelines.

KEY RULES:
1. NONPARTISAN LANGUAGE: Never use terms like "pro-choice", "pro-life", "pro-gun", "anti-immigration". Use neutral alternatives:
   - "pro-choice" → "Supports abortion access"
   - "pro-life" → "Opposes abortion access" 
   - "pro-gun" → "Supports gun rights" → USE "Supports gun ownership" or "Opposes gun control" instead
   - "anti-immigration" → "Supports stricter immigration enforcement"
   - "liberal" / "conservative" → Describe specific positions instead

2. SOURCING — CRITICAL:
   ⚠ You may ONLY cite URLs that appear in the SOURCE MATERIAL provided to you. ⚠
   - Do NOT invent, hallucinate, or guess URLs. If a URL is not in the source material, you MUST NOT use it.
   - Every factual claim MUST have a source URL and supporting direct quote from that source.
   - Every "directQuote" MUST be a VERBATIM excerpt from the source material — do NOT paraphrase or fabricate quotes.
   - If you cannot find a source for a claim in the provided material, mark the stance as unsourced rather than inventing a URL.
   - An unsourced claim is ALWAYS better than a fabricated source.
   - Priority for source types:
     * Candidate's official website (highest priority)
     * Official government sites
     * Reputable news sources
     * Social media (lowest priority)
   - NEVER use BallotReady, VoteSmart, or Wikipedia as sources.

3. FORMATTING:
   - Degrees: lowercase ("law degree" not "Juris Doctorate", "bachelor's degree" not "B.A.")
   - Family: include number of children but NOT their names
   - Professional: current job first, no dates, no descriptions
   - Political: reverse chronological order
   - Stances: start with action verbs, unbundle compound stances into separate items

4. STANCE CATEGORIES (ordered best→worst fit): Economy, Public Safety, Healthcare, Education, Environment, Immigration, Housing, Transportation, Gun Policy, Abortion, Civil Rights, Foreign Policy, Technology, Agriculture, Veterans, Criminal Justice, Consumer Protection, Government Reform, Labor, Social Services, Infrastructure, Legal Experience, Candidate's Background

5. OUTPUT FORMAT: Respond with valid JSON matching the exact schema requested.

6. SOURCE INTEGRITY:
   - Your output will be checked by an automated system that verifies every URL against the input.
   - Any URL not found in the source material will be flagged as FABRICATED and will incur a -50 point penalty.
   - Fabricated sources are treated more severely than missing sources (-50 vs -15).
   - When in doubt, omit the source rather than guess. Set "complete": false on the stance.`;

export interface WriterInput {
  candidateName: string;
  sourceContent: string;
  previousDraft?: Partial<StagingDraft>;
  criticFeedback?: CriticFeedback;
}

/** How many issues to generate per batch. */
const ISSUES_PER_BATCH = 4;

/**
 * Build a structured fix list from critic feedback so the Writer can't ignore issues.
 */
function buildFixInstructions(feedback: CriticFeedback): string {
  if (!feedback.issues || feedback.issues.length === 0) return '';

  const lines: string[] = [];
  lines.push('\n\n═══ REQUIRED FIXES (YOU MUST ADDRESS EVERY ITEM BELOW) ═══');
  lines.push(`The previous draft had ${feedback.issues.length} issue(s). You MUST fix ALL of them.\n`);

  const grouped: Record<string, CriticIssue[]> = {};
  for (const issue of feedback.issues) {
    const key = issue.section || 'general';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(issue);
  }

  let num = 1;
  for (const [section, issues] of Object.entries(grouped)) {
    lines.push(`── Section: ${section} ──`);
    for (const issue of issues) {
      lines.push(`  ${num}. [${issue.severity.toUpperCase()}] ${issue.category}: ${issue.description}`);
      if (issue.suggestion) lines.push(`     → FIX: ${issue.suggestion}`);
      num++;
    }
  }

  lines.push('\nDo NOT ignore any of the above. Apply every fix. If a fix requires removing content, remove it. If it requires rewording, reword it exactly as suggested.');
  if (feedback.failedAgents?.length) {
    lines.push(`\n⚠ WARNING: The following review agents FAILED and could not verify the draft: ${feedback.failedAgents.join(', ')}. Be extra careful in those areas.`);
  }
  return lines.join('\n');
}

/**
 * Filter critic issues to only those relevant to specific sections.
 */
function filterIssuesForSections(feedback: CriticFeedback | undefined, sectionPrefixes: string[]): CriticFeedback | undefined {
  if (!feedback || !feedback.issues.length) return feedback;
  const filtered = feedback.issues.filter(i =>
    sectionPrefixes.some(p => i.section.startsWith(p)) || i.section === 'general',
  );
  if (filtered.length === 0) return undefined;
  return { ...feedback, issues: filtered };
}

/**
 * Step 1: Generate bios (name, links, 3 biographies).
 */
async function generateBios(
  provider: AIProvider,
  input: WriterInput,
): Promise<Pick<StagingDraft, 'name'> & { links: any[]; bios: any[] }> {
  const bioFeedback = filterIssuesForSections(input.criticFeedback, ['bio-']);
  const fixInstructions = bioFeedback ? buildFixInstructions(bioFeedback) : '';

  const existingBios = input.previousDraft?.bios
    ? `\n\nEXISTING BIOS (revise based on feedback):\n${JSON.stringify({ name: input.previousDraft.name, links: input.previousDraft.links, bios: input.previousDraft.bios }, null, 2)}`
    : '';

  const prompt = `Generate the BIOGRAPHIES portion of a candidate profile for "${input.candidateName}".

SOURCE MATERIAL:
${input.sourceContent}
${existingBios}
${fixInstructions}

Return JSON with ONLY these fields:
{
  "name": "Candidate Full Name",
  "links": [{ "mediaType": "website"|"facebook"|"twitter"|"instagram"|"linkedin"|"youtube"|"other", "url": "..." }],
  "bios": [
    { "type": "personal", "text": "Personal background text...", "sources": [{ "sourceType": "website"|"news"|"social"|"other", "directQuote": "exact CMD+F-searchable quote from source", "url": "source url" }], "complete": true },
    { "type": "professional", "text": "Professional background text...", "sources": [...], "complete": true },
    { "type": "political", "text": "Political background text...", "sources": [...], "complete": true }
  ]
}

RULES:
- Full name on first mention (Personal bio) ONLY. Use first name only in Professional and Political bios.
- Every claim needs a source with a "directQuote" that can be found with CMD+F on the source page.
- Degrees lowercase: "law degree", "bachelor's degree in political science"
- Family: number of children, not their names
- Professional: current job first, no dates, no descriptions
- Political: reverse chronological order`;

  return provider.generateJSON<Pick<StagingDraft, 'name'> & { links: any[]; bios: any[] }>(prompt, {
    systemPrompt: TEMPLATE_SYSTEM_PROMPT,
    temperature: 0.3,
    maxTokens: 8192,
  });
}

/**
 * Step 2: Generate a batch of issues/stances.
 */
async function generateIssueBatch(
  provider: AIProvider,
  input: WriterInput,
  issueKeys: string[],
  existingIssues?: any[],
): Promise<any[]> {
  const issueFeedback = filterIssuesForSections(
    input.criticFeedback,
    issueKeys.map(k => `issue-${k}`).concat(issueKeys.map(k => `stance-`)),
  );
  const fixInstructions = issueFeedback ? buildFixInstructions(issueFeedback) : '';

  const existingContext = existingIssues?.length
    ? `\n\nEXISTING ISSUES TO REVISE:\n${JSON.stringify(existingIssues, null, 2)}`
    : '';

  const issueList = issueKeys.map(k => `"${k}"`).join(', ');

  const prompt = `Generate ISSUE & STANCE entries for candidate "${input.candidateName}" for these categories: ${issueList}.

SOURCE MATERIAL:
${input.sourceContent}
${existingContext}
${fixInstructions}

Return JSON — an array of issue objects:
[
  {
    "key": "issue-key",
    "title": "Issue Title",
    "complete": true,
    "stances": [
      {
        "text": "Action-verb stance text (e.g. 'Supports lowering property taxes for working families.')",
        "sources": [{ "sourceType": "website"|"news"|"social"|"other", "directQuote": "exact CMD+F-searchable quote", "url": "source url" }],
        "complete": true,
        "directQuote": "the key quote",
        "issuesSecondary": [],
        "textApproved": false,
        "editsMade": false
      }
    ],
    "textArray": [],
    "sources": [],
    "isTopPriority": false,
    "policyTerms": []
  }
]

RULES:
- Start each stance with an action verb: "Supports", "Opposes", "Advocates for"
- Unbundle compound stances into separate items
- Every stance needs a source with a CMD+F-searchable directQuote
- If no information is available for an issue category, include it with a stance noting "As of February 2026, the candidate's public statements did not contain information on this issue." and set missingData: "issue-specific"
- Use strictly nonpartisan language per the substitution chart`;

  return provider.generateJSON<any[]>(prompt, {
    systemPrompt: TEMPLATE_SYSTEM_PROMPT,
    temperature: 0.3,
    maxTokens: 8192,
  });
}

/**
 * Main entry: Run the Writer agent with chunked generation.
 *
 * Round 1: No previous draft — generate bios, then plan issues from source material, then fill them in batches.
 * Round 2+: Previous draft + critic feedback — generate revised bios, then revised issues in batches.
 */
export async function runWriter(provider: AIProvider, input: WriterInput): Promise<Partial<StagingDraft>> {
  // Step 1: Generate bios
  const biosResult = await generateBios(provider, input);

  // Step 2: Determine which issue categories to generate
  let issueKeys: string[];
  if (input.previousDraft?.issues?.length) {
    // Revision — use the same issue keys from the previous draft
    issueKeys = input.previousDraft.issues.map(i => i.key || i.title);
  } else {
    // First pass — ask the AI to plan which issues to cover
    issueKeys = await planIssueCategories(provider, input);
  }

  // Step 3: Generate issues in batches
  const allIssues: any[] = [];
  for (let i = 0; i < issueKeys.length; i += ISSUES_PER_BATCH) {
    const batchKeys = issueKeys.slice(i, i + ISSUES_PER_BATCH);
    const existingBatchIssues = input.previousDraft?.issues?.filter(
      iss => batchKeys.includes(iss.key) || batchKeys.includes(iss.title),
    );

    try {
      const batchIssues = await generateIssueBatch(provider, input, batchKeys, existingBatchIssues);
      if (Array.isArray(batchIssues)) {
        allIssues.push(...batchIssues);
      }
    } catch (err) {
      // If a batch fails, preserve existing issues for those categories and continue
      if (existingBatchIssues?.length) {
        allIssues.push(...existingBatchIssues);
      }
      // Don't throw — partial progress is better than nothing
    }
  }

  // Merge into final draft
  return {
    name: biosResult.name || input.candidateName,
    links: biosResult.links || [],
    bios: biosResult.bios || [],
    issues: allIssues,
  };
}

/**
 * Ask the AI to determine which issue categories are relevant for this candidate.
 */
async function planIssueCategories(
  provider: AIProvider,
  input: WriterInput,
): Promise<string[]> {
  const prompt = `Given the following source material about "${input.candidateName}", list the issue categories that have relevant policy stances or positions. Only include categories where the source material contains actual policy positions or stances.

SOURCE MATERIAL:
${input.sourceContent.slice(0, 6000)}

Return a JSON array of issue category keys (lowercase, hyphenated). Choose from:
["economy", "public-safety", "healthcare", "education", "environment", "immigration", "housing", "transportation", "gun-policy", "abortion", "civil-rights", "foreign-policy", "technology", "agriculture", "veterans", "criminal-justice", "consumer-protection", "government-reform", "labor", "social-services", "infrastructure", "legal-experience", "candidates-background"]

Only include categories where the candidate has stated positions. Return the JSON array only.`;

  try {
    const keys = await provider.generateJSON<string[]>(prompt, {
      temperature: 0.1,
      maxTokens: 1024,
    });
    return Array.isArray(keys) && keys.length > 0
      ? keys
      : ['economy', 'public-safety', 'healthcare', 'education'];
  } catch {
    // Fallback — common categories
    return ['economy', 'public-safety', 'healthcare', 'education', 'environment', 'gun-policy', 'abortion'];
  }
}

/**
 * Incrementally add a new source to an existing profile.
 * Only updates sections that could benefit from the new information.
 */
export interface AddSourceInput {
  currentDraft: Partial<StagingDraft>;
  candidateName: string;
  newSource: { url: string; title: string; content: string };
}

export async function addSourceToProfile(
  provider: AIProvider,
  input: AddSourceInput,
): Promise<Partial<StagingDraft>> {
  const prompt = `You have an existing candidate profile for "${input.candidateName}" and a NEW source to incorporate.

EXISTING PROFILE:
${JSON.stringify(input.currentDraft, null, 2)}

NEW SOURCE (${input.newSource.url} — ${input.newSource.title}):
${input.newSource.content || '(content not loaded — use the URL as reference)'}

Analyze the new source and determine:
1. Which sections of the profile could be updated or improved with this new information
2. What new stances, bio details, or corrections this source provides

Return JSON:
{
  "changedSections": ["list", "of", "section-keys"],
  "updatedDraft": { ...the full updated profile with the new source incorporated... },
  "changes": [
    { "section": "section-key", "description": "what changed and why" }
  ]
}

RULES:
- Only modify sections where the new source adds genuine value
- Preserve all existing sources — add, don't replace
- Use exact quotes from the new source
- Follow nonpartisan language rules`;

  const result = await provider.generateJSON<{
    changedSections: string[];
    updatedDraft: Partial<StagingDraft>;
    changes: Array<{ section: string; description: string }>;
  }>(prompt, {
    systemPrompt: TEMPLATE_SYSTEM_PROMPT,
    temperature: 0.2,
    maxTokens: 16384,
  });

  return result.updatedDraft;
}
