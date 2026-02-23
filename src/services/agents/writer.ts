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

import type { AIProvider, ChatTurn } from '../aiProvider';
import type { StagingDraft, CriticFeedback, CriticIssue } from '../../types';
import { getCustomPrompt } from '../promptStorage';

export const WRITER_SYSTEM_PROMPT = `You are a nonpartisan political researcher for Branch Politics. Your job is to write factual, sourced candidate profiles following strict editorial guidelines. Profiles must be Simple, Short, and Unbiased.

═══════════════════════════════════════════
SECTION A: SOURCE INTEGRITY (MOST IMPORTANT)
═══════════════════════════════════════════

⚠ You may ONLY cite URLs that appear in the SOURCE MATERIAL provided to you. ⚠
- Do NOT invent, hallucinate, or guess URLs.
- Every factual claim MUST have a source URL and a verbatim supporting quote from that source.
- Every "directQuote" MUST be a VERBATIM excerpt — do NOT paraphrase or fabricate quotes.
- Every supporting quote MUST be CMD+F searchable on the source page.
- If you cannot find a source for a claim, mark the stance as unsourced rather than inventing a URL.
- An unsourced claim is ALWAYS better than a fabricated source.

Source priority (highest to lowest):
1. Candidate's official campaign website
2. Candidate's official social media (LinkedIn for professional/background)
3. Official government websites or voting records
4. Neutral, unbiased third-party news sources
5. Candidate interviews from reputable outlets

NEVER use: Ballot Ready, Vote Smart, Wikipedia, or any source that aggregates information from other sources.

═══════════════════════════════════════════
SECTION B: BACKGROUND SECTIONS
═══════════════════════════════════════════

Write backgrounds in this order: Personal Background → Professional Background → Political Background.
Use the candidate's FULL NAME on the FIRST mention only (which should be in Personal Background).
Use FIRST NAME ONLY for every mention after that, across ALL sections.

--- PERSONAL BACKGROUND ---

Structure: Four sentences maximum.
Sentence 1 — Origin: Where they are from.
Sentence 2 — Education: Educational history.
Sentence 3 — Family & location: Spouse/partner name, number of children, where they live.
Sentence 4 (optional, only if factual) – Volunteer work and/or place of religious attendance

Rules:
- DO include number of children (e.g., "their two children").
- Do NOT include: children's names, pets, in-laws, awards/recognitions.
- Omit current location if it is the same as the district they are running for.
- List high school only if it is the candidate's sole educational history.
- Volunteer work: include briefly only if significant or directly related to the office.
– Religion: include only a specific church/mosque/synagogue/etc. that they attend; do NOT give their religion

Education formatting:
- Use LOWERCASE for degree titles: "bachelor's degree", "master's degree", "law degree"
- NEVER use "Juris Doctorate" — always write "law degree"
- Do NOT capitalize study areas (except proper nouns/languages like "English"): "bachelor's degree in political science"
- Same institution: "bachelor's degree in [subject] and master's degree in [subject] from [Institution]"
- Different institutions: "bachelor's degree in [subject] from [Institution] and law degree from [Institution]"

TEMPLATE:
  [Candidate Full Name] is originally from [hometown]. [He/She/They] earned [his/her/their] [degree] in [subject] from [Institution]. [First name] lives in [city] with [his/her/their] [wife/husband/partner], [Spouse Name], and their [#] children.

  SOURCE URLs:
  Origin: {URL} | QUOTE: "[exact quote]"
  Education: {URL} | QUOTE: "[exact quote]"
  Family: {URL} | QUOTE: "[exact quote]"

EXAMPLE (CORRECT):
  "Sarah Johnson is originally from Atlanta, Georgia. She earned her bachelor's degree in political science from the University of Georgia and her law degree from Emory University. Sarah lives with her husband Michael and their two children in Decatur."

EXAMPLE (WRONG — do NOT do this):
  "Sarah Johnson is originally from Atlanta, Georgia. She earned her Bachelor's Degree in Political Science from the University of Georgia and her Juris Doctorate from Emory University. Sarah lives with her husband Michael and their children, Emma and Jake, and their dog Max in Decatur."
  ↑ Problems: capitalized "Bachelor's Degree", capitalized "Political Science", used "Juris Doctorate", included children's names, included pet.

--- PROFESSIONAL BACKGROUND ---

Rules:
- Current or most recent job FIRST.
- NO dates. NO detailed role descriptions. NO past accomplishments.
- Do NOT include volunteer positions (those go in Personal Background).
- If a company name is unclear, add a very brief descriptor (a few words at most).

TEMPLATE:
  [First name] currently works as a [job title] at [Employer Name]. [He/She/They] previously worked as a [past job titles — comma-separated list].

  SOURCE URL: {URL} | QUOTE: "[exact quote]"

Military service format:
  [He/She/They] served as a [rank] in the U.S. [branch] for [length of time].

EXAMPLE (CORRECT):
  "Sarah currently works as a partner at Johnson & Associates Law Firm. She previously worked as an assistant district attorney and public defender."

EXAMPLE (WRONG — do NOT do this):
  "Sarah Johnson currently works as a partner at Johnson & Associates Law Firm since 2018. She previously worked as an assistant district attorney from 2012-2015 where she prosecuted over 200 cases and won 95% of them, and as a public defender."
  ↑ Problems: full name (should be first name), includes dates, includes role description and accomplishments.

--- POLITICAL BACKGROUND ---

Rules:
- Reverse chronological order — current elected position FIRST.
- Include ONLY elected government positions.
- Appointments count only for offices that are usually elected. Appointments do NOT count as elected terms.
- Exclude: party positions (majority leader, precinct delegate), committee assignments.

Use the appropriate template(s) and combine as needed:

Currently holds position + running for re-election:
  [First name] currently serves as the [position] for [State, District #]. [He/She/They] was/were first elected in [year] and is serving [his/her/their] [#] term.

Currently holds position + running for new office:
  [First name] currently serves as the [position] for [State, District #]. [He/She/They] was/were first elected in [year] and is in [his/her/their] [#] term.

Previously held position:
  [First name] previously served as a [position]. [He/She/They] served [#] terms from [start year] to [end year].

First run for public office:
  [First name]'s campaign for [office] is [his/her/their] first run for public office.

Previously ran but lost:
  [First name] previously ran for [office] in [year], but did not win.

  SOURCE URL(s): {URL} | QUOTE: "[exact quote]"

Note: If there is no Personal Background AND no Professional Background information, use the candidate's full name in Political Background instead of first name.

EXAMPLE (CORRECT — combined templates):
  "Sarah currently serves as the state representative for Georgia, District 42. She was first elected in 2020 and is serving her second term. Sarah previously ran for state senate in 2018, but did not win."

EXAMPLE (WRONG — do NOT do this):
  "Sarah Johnson currently serves as the State Representative for Georgia's 42nd District, where she chairs the Education Committee. She was first elected in 2020."
  ↑ Problems: full name (should be first name after Personal section), capitalized "State Representative", included committee assignment, "42nd District" should be "District 42".

--- LEGAL EXPERIENCE (Judicial and legal candidates ONLY) ---

Rules:
- Do NOT repeat law degrees (already in Personal Background).
- Do NOT include bar admission year.
- If candidate provides specifics, use those instead of the generic description.
- Keep descriptions short, unbiased, and simple.
- Include length of time in position if known.

TEMPLATE:
  As a [position title] [at [firm/court name]] [for [#] years], [description of duties].

  SOURCE URL: {URL} | QUOTE: "[exact quote]"

EXAMPLE — candidate provides specifics:
  "As a superior court judge for 12 years, specialized in divorce cases and oversaw cases involving criminal felonies, the administration of wills and estates, the evictions of renters, and exercised authority to review and correct the rulings of lower courts."

EXAMPLE — no specifics (use generic description):
  "As a legal associate at Smith & Associates, researched, drafted, and filed legal documents, and provided defense and counsel to clients, specializing in criminal defense and family law."

EXAMPLE — prosecutor:
  "As a district attorney for six years, prosecuted civil and criminal actions under state law and presented cases before grand juries."

═══════════════════════════════════════════
SECTION C: ISSUE STANCES
═══════════════════════════════════════════

Rules:
- Each stance MUST begin with a varied action verb. Do NOT repeat the same verb consecutively.
  Allowed starters: Said, Supports, Advocates, Opposes, Believes, Plans, Wants to (use sparingly)
- NEVER use "Claims" (implies doubt).
- NEVER start a stance with the candidate's name.
- Focus on forward-looking policy commitments, NOT past accomplishments.
- UNBUNDLE compound stances into separate, focused stances. Each stance = ONE policy area.
- No redundancy — do not restate the same position with different wording.
- Use nonpartisan language (see Nonpartisan Language Chart below).
- Use [square brackets] for any edits to direct quotes.
- Use quotation marks for strongly worded rhetoric, partisan language, or direct candidate quotes.
- Inflammatory language: honor the candidate's actual tone using direct quotes. DO NOT INCLUDE SLURS — this is absolute.

ACCOMPLISHMENT CLAIMS (CRITICAL):
- Campaign websites are self-promotional. Broad claims are NOT verified facts.
- "I cut taxes" → write "Supports cutting taxes" UNLESS a specific bill number is cited.
- "I passed legislation..." without a bill number → write "Supports legislation that..."
- ONLY use "As a [office], sponsored/supported/voted for [Bill Name (Abbreviation) ##]" when the bill number is specific and verifiable.

Incumbent legislation format:
  As a [past office], [passed/supported/opposed/sponsored] [Bill Name (Abbreviation) ##] that [what the bill does].

Stance formats:
  [Action verb] [policy position in nonpartisan language].
  [Action verb], "[direct quote from candidate]."
  [Action verb] [policy position], and said "[partial or full quote]."

For each stance, include:
  STANCE: [formatted text]
  CATEGORIES: [best fit, next best fit, etc. — see category list below]
  SOURCE URL: {URL}
  SUPPORTING QUOTE: "[exact quote, CMD+F searchable on source page]"

EXAMPLE — properly unbundled stances (CORRECT):
  STANCE: Supports increased funding for public education.
  CATEGORIES: Education, Public Services, Economy
  SOURCE URL: {https://sarahforgeorgia.com/issues/education}
  SUPPORTING QUOTE: "I will fight for increased funding for our public schools."

  STANCE: Advocates for reducing class sizes in Georgia schools.
  CATEGORIES: Education, School Curriculum
  SOURCE URL: {https://sarahforgeorgia.com/issues/education}
  SUPPORTING QUOTE: "I will work to reduce class sizes so every student gets the individual attention they deserve."

  STANCE: Plans to raise teacher salaries.
  CATEGORIES: Teachers, Education, Economy
  SOURCE URL: {https://sarahforgeorgia.com/issues/education}
  SUPPORTING QUOTE: "Our teachers deserve competitive pay that reflects their vital role."

EXAMPLE — bundled stance (WRONG — do NOT do this):
  STANCE: Supports increased funding for public education, reducing class sizes, raising teacher salaries, implementing universal pre-K programs, and expanding after-school activities.
  ↑ Problem: five separate policy positions crammed into one stance. Split them apart.

EXAMPLE — incumbent legislation (CORRECT):
  STANCE: As a state representative, sponsored House Bill (HB) 142 that increased funding for public schools by $500 million.
  CATEGORIES: Education, Economy, Public Services
  SOURCE URL: {URL}
  SUPPORTING QUOTE: "[exact quote]"

EXAMPLE — unverified accomplishment converted to position (CORRECT):
  STANCE: Supports cutting property taxes for homeowners.
  (NOT "Cut property taxes by 15% as commissioner" — unless a specific bill/vote is cited)

═══════════════════════════════════════════
SECTION D: STANCE CATEGORIES
═══════════════════════════════════════════

Use ONLY the categories below. For each stance, list categories from best fit (most specific) to worst fit (broadest). Include all that genuinely apply.

Available categories:
Economy, Public Safety, Healthcare, Education, Energy & the Environment, Foreign Policy and Immigration, Voting & Elections, Consumer Protection, Housing & Urban Development, Public Services, Public Health, School Curriculum, Businesses, Small Businesses, Fire Safety, Insurance, Teachers, Administration, Criminal Justice, Taxes, Financial Management, Retirement, Ethics & Corruption

Category ordering examples:
- "Supports raising teacher salaries" → Teachers, Education, Public Services
- "Plans to reduce property taxes for small businesses" → Small Businesses, Taxes, Businesses, Economy
- "Opposes abortion access" → Healthcare, Public Health
- "Supports universal background checks for gun purchases" → Public Safety, Criminal Justice
- "Advocates for renewable energy subsidies for homeowners" → Energy & the Environment, Housing & Urban Development, Economy
- "Supports voter ID requirements" → Voting & Elections, Administration

═══════════════════════════════════════════
SECTION E: NONPARTISAN LANGUAGE CHART
═══════════════════════════════════════════

NEVER use this...                          → ALWAYS say this instead...
Pro-choice / pro-life / abortion rights    → Supports abortion access / Opposes abortion access
Global Warming / Climate Crisis            → Climate change / supports policies that address climate change
Second Amendment rights / gun rights /     → Supports gun control / Opposes gun control
  pro-gun / anti-gun / common-sense gun reform
Critical Race Theory (CRT)                 → Education on race and racism
Securing the border / Illegal immigration  → Reduce immigration / reduce undocumented immigration / undocumented immigrants
America first                              → Opposes intervention in international conflicts and prioritizes domestic policy
Protect integrity of women's sports /      → Supports/opposes the participation of transgender athletes
  oppose biological males in women's sports     [or transgender women] in [type of sports]
Parent's choice on best education          → Supports school voucher programs that allow parents to use
                                              public funds to enroll their children in schools beyond
                                              their local options, including private schools

═══════════════════════════════════════════
SECTION F: GENERAL FORMATTING RULES
═══════════════════════════════════════════

- Names: Full name on FIRST mention only (in Personal Background). First name only after that.
- Acronyms: Spell out every time. Exception: U.S. and PhD may stay abbreviated.
  Format: "Occupational Safety and Health Administration (OSHA)", "House Bill (HB) 00"
- Capitalization: Only proper nouns. Do NOT capitalize job titles or degrees.
  Office titles capitalized only before a name: "President Biden" but "she served as a senator."
- Numbers: Spell out one through ten. Use numerals for 11 and above.
  Exception: Districts ALWAYS use numerals (District 5, not District five).
- Contractions: Do NOT use contractions. Write "cannot" not "can't", "does not" not "doesn't".
- Editing quotes: Use [square brackets] for any edits to direct quotes.

═══════════════════════════════════════════
SECTION G: SOURCE INTEGRITY SCORING
═══════════════════════════════════════════

Your output will be checked by an automated system that verifies every URL against the input.
- Any URL not found in the source material will be flagged as FABRICATED (-50 points each).
- Fabricated sources are treated more severely than missing sources (-50 vs -15).
- When in doubt, omit the source rather than guess. Set "complete": false on the stance.

OUTPUT FORMAT: Respond with valid JSON matching the exact schema requested.`;

export interface WriterInput {
  candidateName: string;
  sourceContent: string;
  previousDraft?: Partial<StagingDraft>;
  criticFeedback?: CriticFeedback;
}

/** How many issues to generate per batch. */
const ISSUES_PER_BATCH = 4;

/** Sentinel string returned by webResearch when no pages are found */
const NO_SOURCE_SENTINEL = '(No source material found from web research)';

/**
 * Transform source content to include explicit no-source instructions when empty.
 * This prevents the Writer from fabricating information.
 */
function prepareSourceContent(sourceContent: string, candidateName: string): string {
  const trimmed = sourceContent.trim();
  if (!trimmed || trimmed === NO_SOURCE_SENTINEL) {
    // Extract first name for use in templates
    const firstName = candidateName.split(/\s+/)[0];
    return `⚠ NO SOURCE MATERIAL AVAILABLE ⚠
No web research results were found for ${candidateName}.

STRICT INSTRUCTIONS FOR NO-SOURCE PROFILES:
- Do NOT fabricate any claims, quotes, URLs, or biographical details.
- Do NOT invent social media links, campaign websites, or news articles.
- Do NOT output template placeholders like [hometown], [degree], [Institution], [job title], [Employer Name], [Spouse Name], or any text in [square brackets]. These are template examples — NOT fill-in-the-blank patterns.
- For personal bio: write "As of February 2026, ${candidateName}'s personal background information was not available." and set complete: false.
- For professional bio: write "As of February 2026, ${candidateName}'s professional background information was not available." and set complete: false.
- For political bio: write "As of February 2026, ${firstName} has not held elected office." and set complete: false.
- For each issue category: write a single stance stating "As of February 2026, ${candidateName}'s public statements did not contain information on this issue." and set missingData: "issue-specific".
- Every source array must be EMPTY []. Do not create fake sources.
- The links array must be EMPTY [].`;
  }
  return trimmed;
}

/**
 * Build a structured fix list from critic feedback so the Writer can't ignore issues.
 */
function buildFixInstructions(feedback: CriticFeedback): string {
  if (!feedback.issues || feedback.issues.length === 0) return '';

  const lines: string[] = [];
  lines.push('\n\n═══ REQUIRED FIXES (YOU MUST ADDRESS EVERY ITEM BELOW) ═══');
  lines.push(`The previous draft had ${feedback.issues.length} issue(s). You MUST fix ALL of them.\n`);

  // Collect fabricated URLs for an explicit blocklist
  const fabricatedUrls = feedback.issues
    .filter(i => i.severity === 'fabrication' || i.category === 'fabricated-source')
    .map(i => {
      // Try to extract URL from description or suggestion
      const urlMatch = (i.description + ' ' + (i.suggestion || '')).match(/https?:\/\/[^\s"'<>]+/);
      return urlMatch ? urlMatch[0] : null;
    })
    .filter((u): u is string => u !== null);

  if (fabricatedUrls.length > 0) {
    lines.push('⛔ FABRICATED URL BLOCKLIST — These URLs were NOT in the source material.');
    lines.push('   You MUST NOT include ANY of these URLs in your output:');
    for (const url of fabricatedUrls) {
      lines.push(`   ✗ ${url}`);
    }
    lines.push('   Remove them completely. Do NOT replace them. If a claim has no other source, set "complete": false.\n');
  }

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
 * Extract fabricated URLs from critic feedback and strip them from a draft object.
 * Returns a cleaned copy — the original is not mutated.
 */
function stripFabricatedUrls<T extends Record<string, any>>(
  obj: T,
  feedback: CriticFeedback | undefined,
): T {
  if (!feedback) return obj;

  const fabricatedUrls = new Set<string>();
  for (const issue of feedback.issues) {
    if (issue.severity === 'fabrication' || issue.category === 'fabricated-source') {
      const urlMatch = (issue.description + ' ' + (issue.suggestion || '')).match(/https?:\/\/[^\s"'<>]+/);
      if (urlMatch) fabricatedUrls.add(urlMatch[0]);
    }
  }
  if (fabricatedUrls.size === 0) return obj;

  // Deep clone then strip
  const clean: any = JSON.parse(JSON.stringify(obj));

  // Strip from links
  if (Array.isArray(clean.links)) {
    clean.links = clean.links.filter((l: any) => !fabricatedUrls.has(l.url));
  }
  // Strip from bios
  if (Array.isArray(clean.bios)) {
    for (const bio of clean.bios) {
      if (Array.isArray(bio.sources)) {
        bio.sources = bio.sources.filter((s: any) => !fabricatedUrls.has(s.url));
      }
    }
  }
  // Strip from issues/stances
  if (Array.isArray(clean.issues)) {
    for (const issue of clean.issues) {
      if (Array.isArray(issue.stances)) {
        for (const stance of issue.stances) {
          if (Array.isArray(stance.sources)) {
            stance.sources = stance.sources.filter((s: any) => !fabricatedUrls.has(s.url));
          }
        }
      }
    }
  }
  return clean;
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

  // Strip fabricated URLs from existing draft before passing back to the writer
  const cleanedPrev = input.previousDraft
    ? stripFabricatedUrls(input.previousDraft, input.criticFeedback)
    : undefined;

  const existingBios = cleanedPrev?.bios
    ? `\n\nEXISTING BIOS (revise based on feedback):\n${JSON.stringify({ name: cleanedPrev.name, links: cleanedPrev.links, bios: cleanedPrev.bios }, null, 2)}`
    : '';

  const prompt = `Generate the BIOGRAPHIES portion of a candidate profile for "${input.candidateName}".

SOURCE MATERIAL:
${prepareSourceContent(input.sourceContent, input.candidateName)}
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

═══════════════════════════════════════════
BIO FORMAT — STRICT RULES (MUST FOLLOW EXACTLY)
═══════════════════════════════════════════

PERSONAL BIO: Origin → Education → Family/Location.
  GOOD: "Maria Elena Garcia was raised in San Antonio. She earned a bachelor's degree in criminal justice from the University of Texas at San Antonio and a law degree from St. Mary's University School of Law. She has three children."
  BAD (too long, narrative, includes job info): "Maria Elena Garcia is a dedicated public servant who has spent decades fighting for justice in Bexar County. She was born and raised in San Antonio, Texas, where she developed a passion for law enforcement. She graduated from the University of Texas with a Bachelor of Arts in Criminal Justice..."
  RULES: Full name on FIRST mention only. Lowercase degrees. Number of children, NOT names. 2-3 sentences max. No job descriptions — that's for professional bio.

PROFESSIONAL BIO: Current job title and employer ONLY. ONE sentence. Past non-political jobs listed without dates or descriptions.
  GOOD: "Maria is a prosecutor in the Bexar County District Attorney's Office."
  GOOD: "John is a partner at Smith & Associates. He previously worked as an assistant district attorney."
  BAD (includes elected positions): "Maria is a prosecutor and currently serves as a county commissioner."
  BAD (includes dates): "Maria has served as a prosecutor since 2015."
  BAD (includes duties): "Maria is a prosecutor handling complex felony cases and mentoring junior attorneys."

  *** CRITICAL: The professional bio must NEVER include elected offices, political positions, government appointments, or any role obtained through election or political appointment. Those belong ONLY in the political bio. ***
  *** If a candidate's only job is an elected position (e.g., full-time mayor), the professional bio should describe what they did BEFORE holding office, or state their pre-office profession. ***

POLITICAL BIO: Elected positions only, reverse chronological. MUST include the year first elected and term information where available.
  GOOD: "Maria ran for Bexar County district attorney in 2024 but did not win. She was elected to the San Antonio City Council District 5 seat in 2018."
  GOOD: "John has served as state representative for District 42 since 2020. He was re-elected in 2022. He previously served on the Dallas City Council from 2016 to 2020."
  BAD (missing years): "Maria serves on the city council and ran for district attorney."
  BAD (includes non-elected roles): "Maria is a well-known community leader who has been involved in local politics for many years. She serves on several boards and committees."
  BAD (missing term info): "John is a state representative." (Should include year elected and district)

  *** CRITICAL: Every elected position mentioned MUST include the year first elected/appointed. Terms served (if re-elected) must be noted. If the candidate has not held elected office, write: "As of February 2026, [first name] has not held elected office." ***
  *** NEVER include board memberships, committee assignments, community leadership roles, or appointed (non-elected) positions in the political bio. ***

═══════════════════════════════════════════
CROSS-CONTAMINATION PREVENTION (MUST FOLLOW)
═══════════════════════════════════════════

Each bio type has a STRICT lane. Content MUST NOT leak between sections:

| Content Type | Personal | Professional | Political |
|---|---|---|---|
| Where raised / hometown | ✅ | ❌ | ❌ |
| Education / degrees | ✅ | ❌ | ❌ |
| Family / children | ✅ | ❌ | ❌ |
| Current residence | ✅ | ❌ | ❌ |
| Job title / employer | ❌ | ✅ | ❌ |
| Past non-political jobs | ❌ | ✅ | ❌ |
| Elected offices held | ❌ | ❌ | ✅ |
| Election results (won/lost) | ❌ | ❌ | ✅ |
| Year elected / terms served | ❌ | ❌ | ✅ |
| Campaign activity | ❌ | ❌ | ✅ |

If an item could go in multiple sections, put it in ONLY the section marked ✅ above.

ADDITIONAL RULES:
- Every claim needs a source with a "directQuote" that can be found with CMD+F on the source page.
- Degrees lowercase: "law degree", "bachelor's degree in political science"
- Family: number of children, not their names
- Keep each bio CONCISE — 1-3 sentences. Do NOT write essays or narratives.`;

  const result = await provider.generateJSON<Pick<StagingDraft, 'name'> & { links: any[]; bios: any[] }>(prompt, {
    systemPrompt: getCustomPrompt('writer') ?? WRITER_SYSTEM_PROMPT,
    temperature: 0.3,
    maxTokens: 8192,
  });

  // Post-process: strip template bracket placeholders that the LLM may have output
  // when no source material was available (e.g., "[hometown]", "[degree]", "[Spouse Name]")
  if (result.bios) {
    const bracketPattern = /\[(?:hometown|degree|subject|Institution|job title|Employer Name|city|wife|husband|partner|Spouse Name|#|First name|He\/She\/They|his\/her\/their)\]/gi;
    for (const bio of result.bios) {
      if (bio.text && bracketPattern.test(bio.text)) {
        const firstName = input.candidateName.split(/\s+/)[0];
        // The bio contains unfilled template placeholders — replace with proper "not available" text
        if (bio.type === 'personal') {
          bio.text = `As of February 2026, ${input.candidateName}'s personal background information was not available.`;
        } else if (bio.type === 'professional') {
          bio.text = `As of February 2026, ${input.candidateName}'s professional background information was not available.`;
        } else if (bio.type === 'political') {
          bio.text = `As of February 2026, ${firstName} has not held elected office.`;
        }
        bio.sources = [];
        bio.complete = false;
      }
    }
  }

  return result;
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
    ? `\n\nEXISTING ISSUES TO REVISE:\n${JSON.stringify(
        stripFabricatedUrls({ issues: existingIssues }, input.criticFeedback).issues,
        null, 2)}`
    : '';

  const issueList = issueKeys.map(k => `"${k}"`).join(', ');

  const prompt = `Generate ISSUE & STANCE entries for candidate "${input.candidateName}" for these categories: ${issueList}.

SOURCE MATERIAL:
${prepareSourceContent(input.sourceContent, input.candidateName)}
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
    systemPrompt: getCustomPrompt('writer') ?? WRITER_SYSTEM_PROMPT,
    temperature: 0.3,
    maxTokens: 8192,
  });
}

/**
 * Main entry: Run the Writer agent with chunked generation and shared conversation context.
 *
 * Context retention strategy:
 * - Turn 1 (user): system context + source material + bio request
 * - Turn 1 (assistant): bio JSON
 * - Turn 2 (user): "Now plan which issue categories..." (no source re-send)
 * - Turn 2 (assistant): issue category list
 * - Turn 3-N (user): "Now generate issues for batch [X]..." (no source re-send)
 * - Turn 3-N (assistant): issue JSON
 *
 * For Gemini: uses native multi-turn `contents` array — source material in context window once.
 * For other providers: falls back to a concatenated-history approach.
 *
 * Token savings: ~60% reduction per candidate on first-pass generation.
 */
export async function runWriter(provider: AIProvider, input: WriterInput): Promise<Partial<StagingDraft>> {
  const systemPrompt = getCustomPrompt('writer') ?? WRITER_SYSTEM_PROMPT;
  const options = { systemPrompt, temperature: 0.3, maxTokens: 8192 };

  // Build the opening context message that carries the source material.
  // All subsequent turns reference this via conversation history.
  const preparedSource = prepareSourceContent(input.sourceContent, input.candidateName);
  const fixInstructions = input.criticFeedback ? buildFixInstructions(input.criticFeedback) : '';
  const cleanedPrev = input.previousDraft
    ? stripFabricatedUrls(input.previousDraft, input.criticFeedback)
    : undefined;

  const openingContext = `You are generating a Branch Politics candidate profile for "${input.candidateName}".

SOURCE MATERIAL (retained in context for all steps — do NOT ask for it again):
${preparedSource}
${fixInstructions}

I will ask you to generate different sections of the profile in separate messages. Wait for each instruction before generating.`;

  // ── Step 1: Bios ──
  const bioFeedback = filterIssuesForSections(input.criticFeedback, ['bio-']);
  const bioFixInstructions = bioFeedback ? buildFixInstructions(bioFeedback) : '';
  const existingBios = cleanedPrev?.bios
    ? `\n\nEXISTING BIOS (revise based on feedback):\n${JSON.stringify({ name: cleanedPrev.name, links: cleanedPrev.links, bios: cleanedPrev.bios }, null, 2)}`
    : '';

  const bioRequest = `Generate the BIOGRAPHIES portion of the profile.
${existingBios}
${bioFixInstructions}

Return JSON with ONLY these fields:
{
  "name": "Candidate Full Name",
  "links": [{ "mediaType": "website"|"facebook"|"twitter"|"instagram"|"linkedin"|"youtube"|"other", "url": "..." }],
  "bios": [
    { "type": "personal", "text": "...", "sources": [{ "sourceType": "website"|"news"|"social"|"other", "directQuote": "...", "url": "..." }], "complete": true },
    { "type": "professional", "text": "...", "sources": [...], "complete": true },
    { "type": "political", "text": "...", "sources": [...], "complete": true }
  ]
}

═══════════════════════════════════════════
BIO FORMAT — STRICT RULES (MUST FOLLOW EXACTLY)
═══════════════════════════════════════════

PERSONAL BIO: Origin → Education → Family/Location.
  GOOD: "Maria Elena Garcia was raised in San Antonio. She earned a bachelor's degree in criminal justice from the University of Texas at San Antonio and a law degree from St. Mary's University School of Law. She has three children."
  RULES: Full name on FIRST mention only. Lowercase degrees. Number of children, NOT names. 2-3 sentences max. No job descriptions.

PROFESSIONAL BIO: Current job title and employer ONLY. Past non-political jobs listed without dates.
  GOOD: "Maria is a prosecutor in the Bexar County District Attorney's Office."
  *** CRITICAL: NEVER include elected offices here — those belong ONLY in the political bio. ***

POLITICAL BIO: Elected positions only, reverse chronological. MUST include year first elected and terms served.
  GOOD: "John has served as state representative for District 42 since 2020 and was re-elected in 2022."
  *** CRITICAL: Every elected position MUST include year elected. Missing years = flagged as MAJOR. ***
  If no elected office: "As of February 2026, [first name] has not held elected office."

ADDITIONAL RULES:
- Every claim needs a source with a "directQuote" CMD+F-searchable on the source page.
- Degrees lowercase. Family: number of children, not their names.
- Keep each bio CONCISE — 1-3 sentences.`;

  // Kick off the conversation with the opening context + bio request combined
  const firstMessage = `${openingContext}\n\n---\n\n${bioRequest}`;

  let history: ChatTurn[] = [];
  const { result: biosResult, updatedHistory: historyAfterBios } =
    await provider.generateJSONWithHistory<{ name: string; links: any[]; bios: any[] }>(
      history,
      firstMessage,
      options,
    );
  history = historyAfterBios;

  // Post-process: strip any bracket placeholders from bios
  if (biosResult?.bios) {
    const bracketPattern = /\[(?:hometown|degree|subject|Institution|job title|Employer Name|city|wife|husband|partner|Spouse Name|#|First name|He\/She\/They|his\/her\/their)\]/gi;
    for (const bio of biosResult.bios) {
      if (bio.text && bracketPattern.test(bio.text)) {
        const firstName = input.candidateName.split(/\s+/)[0];
        if (bio.type === 'personal') bio.text = `As of February 2026, ${input.candidateName}'s personal background information was not available.`;
        else if (bio.type === 'professional') bio.text = `As of February 2026, ${input.candidateName}'s professional background information was not available.`;
        else if (bio.type === 'political') bio.text = `As of February 2026, ${firstName} has not held elected office.`;
        bio.sources = [];
        bio.complete = false;
      }
    }
  }

  // ── Step 2: Issue categories ──
  let issueKeys: string[];
  if (input.previousDraft?.issues?.length) {
    issueKeys = input.previousDraft.issues.map(i => i.key || i.title);
  } else {
    // Ask for issue planning as a follow-up — no source re-send needed
    const isSourceless = !input.sourceContent.trim() || input.sourceContent.trim() === '(No source material found from web research)';
    if (isSourceless) {
      issueKeys = ['economy', 'public-safety', 'healthcare', 'education'];
    } else {
      const planRequest = `Based on the source material you already have in context, which issue categories have enough information for policy stances?

Return a JSON array of issue category keys (lowercase, hyphenated) chosen ONLY from this list:
["economy", "public-safety", "healthcare", "education", "energy-environment", "foreign-policy-immigration", "voting-elections", "consumer-protection", "housing-urban-development", "public-services", "public-health", "school-curriculum", "businesses", "small-businesses", "fire-safety", "insurance", "teachers", "administration", "criminal-justice", "taxes", "financial-management", "retirement", "ethics-corruption"]

RULES:
- Only include categories where the candidate has SPECIFIC stated positions.
- Rank by how much source material supports them — strongest first.
- Return 4-8 categories. If fewer than 4 have strong support, return only what is supported.
- Return the JSON array only.`;

      try {
        const { result: plannedKeys, updatedHistory: historyAfterPlan } =
          await provider.generateJSONWithHistory<string[]>(history, planRequest, { ...options, maxTokens: 512, temperature: 0.1 });
        history = historyAfterPlan;
        issueKeys = Array.isArray(plannedKeys) && plannedKeys.length > 0
          ? plannedKeys
          : ['economy', 'public-safety', 'healthcare', 'education'];
      } catch {
        issueKeys = ['economy', 'public-safety', 'healthcare', 'education'];
      }
    }
  }

  // ── Step 3: Issue batches (each as a follow-up turn) ──
  const allIssues: any[] = [];
  for (let i = 0; i < issueKeys.length; i += ISSUES_PER_BATCH) {
    const batchKeys = issueKeys.slice(i, i + ISSUES_PER_BATCH);
    const existingBatchIssues = input.previousDraft?.issues?.filter(
      iss => batchKeys.includes(iss.key) || batchKeys.includes(iss.title),
    );

    const issueFeedback = filterIssuesForSections(
      input.criticFeedback,
      batchKeys.map(k => `issue-${k}`).concat(['stance-']),
    );
    const issueFix = issueFeedback ? buildFixInstructions(issueFeedback) : '';
    const existingContext = existingBatchIssues?.length
      ? `\n\nEXISTING ISSUES TO REVISE:\n${JSON.stringify(
          stripFabricatedUrls({ issues: existingBatchIssues }, input.criticFeedback).issues, null, 2)}`
      : '';

    const batchRequest = `Now generate ISSUE & STANCE entries for these categories: ${batchKeys.map(k => `"${k}"`).join(', ')}.
${existingContext}
${issueFix}

Return a JSON array of issue objects:
[
  {
    "key": "issue-key",
    "title": "Issue Title",
    "complete": true,
    "stances": [
      {
        "text": "Action-verb stance text.",
        "sources": [{ "sourceType": "website"|"news"|"social"|"other", "directQuote": "exact CMD+F quote", "url": "source url" }],
        "complete": true,
        "directQuote": "key quote",
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
- Start each stance with: "Supports", "Opposes", "Advocates for", "Plans to", "Believes", "Said", "Wants to"
- Unbundle compound stances into separate items
- Every stance needs a CMD+F-searchable directQuote
- If no info available: use stance "As of February 2026, [candidate]'s public statements did not contain information on this issue." and set missingData: "issue-specific"
- Strictly nonpartisan language`;

    try {
      const { result: batchIssues, updatedHistory: historyAfterBatch } =
        await provider.generateJSONWithHistory<any[]>(history, batchRequest, options);
      history = historyAfterBatch;
      if (Array.isArray(batchIssues)) {
        allIssues.push(...batchIssues);
      }
    } catch (err) {
      if (existingBatchIssues?.length) {
        allIssues.push(...existingBatchIssues);
      }
    }
  }

  return {
    name: (biosResult?.name as string) || input.candidateName,
    links: biosResult?.links || [],
    bios: biosResult?.bios || [],
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
  // If source content is empty or just the "no material" sentinel, don't waste an API call
  const trimmed = input.sourceContent.trim();
  const isSourceless = !trimmed || trimmed === '(No source material found from web research)';
  if (isSourceless) {
    // Return a minimal set — Writer will mark all as "no information available"
    return ['economy', 'public-safety', 'healthcare', 'education'];
  }

  const prompt = `Given the following source material about "${input.candidateName}", list the issue categories that have relevant policy stances or positions. Only include categories where the source material contains actual policy positions or stances.

SOURCE MATERIAL:
${input.sourceContent.slice(0, 6000)}

Return a JSON array of issue category keys (lowercase, hyphenated). Choose ONLY from this list:
["economy", "public-safety", "healthcare", "education", "energy-environment", "foreign-policy-immigration", "voting-elections", "consumer-protection", "housing-urban-development", "public-services", "public-health", "school-curriculum", "businesses", "small-businesses", "fire-safety", "insurance", "teachers", "administration", "criminal-justice", "taxes", "financial-management", "retirement", "ethics-corruption"]

RULES:
- Only include categories where the candidate has SPECIFIC stated positions in the source material.
- RANK categories by how much source material supports them — strongest first.
- Each category must have at least one concrete, sourceable policy stance.
- Return 4-8 categories maximum.
- If fewer than 4 categories have strong support, return only what is supported — do NOT pad with unsupported categories.

Return the JSON array only.`;

  try {
    const keys = await provider.generateJSON<string[]>(prompt, {
      temperature: 0.1,
      maxTokens: 1024,
    });
    return Array.isArray(keys) && keys.length > 0
      ? keys
      : ['economy', 'public-safety', 'healthcare', 'education'];
  } catch {
    // Fallback — common categories (minimal set)
    return ['economy', 'public-safety', 'healthcare', 'education'];
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
    systemPrompt: getCustomPrompt('writer') ?? WRITER_SYSTEM_PROMPT,
    temperature: 0.2,
    maxTokens: 16384,
  });

  return result.updatedDraft;
}
