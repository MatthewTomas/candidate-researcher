/**
 * Web Research Service
 *
 * Searches the web for a candidate and fetches actual page content to use
 * as source material for the Writer. Supports DuckDuckGo (free, default)
 * and Google Custom Search (requires API key).
 *
 * Flow:
 *  1. Build search queries from candidate name + metadata
 *  2. Hit search engine → collect result URLs
 *  3. Merge with user-provided source URLs (if any)
 *  4. Fetch each URL via CORS proxy → extract text with DOMParser
 *  5. Return structured ResearchResult with all fetched content
 */

import type { CandidateMetadata, AppSettings } from '../types';
import { Readability } from '@mozilla/readability';

// ============================================================================
// Types
// ============================================================================

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface FetchedPage {
  url: string;
  title: string;
  text: string;           // extracted text content
  fetchedAt: string;
  byteLength: number;
  error?: string;         // if fetch failed
  /** Source bias tier — lower is more trustworthy */
  biasTier?: 1 | 2 | 3 | 4;
}

export interface ResearchResult {
  pages: FetchedPage[];
  searchQueries: string[];
  searchResults: SearchResult[];
  userProvidedUrls: string[];
  totalFetched: number;
  totalFailed: number;
  /** True if all search queries returned 0 results — indicates systemic search failure */
  searchFailure?: boolean;
}

// ============================================================================
// CORS Proxy — needed because browser can't fetch arbitrary origins
// ============================================================================

const CORS_PROXIES = [
  'https://corsproxy.io/?',
  'https://api.allorigins.win/raw?url=',
  'https://corsproxy.org/?',
  'https://api.codetabs.com/v1/proxy/?quest=',
  'https://thingproxy.freeboard.io/fetch/',
];

/** Shuffle array in-place (Fisher-Yates) */
function shuffleArray<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function fetchViaCorsProxy(url: string, timeoutMs = 10000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Randomize proxy order for load distribution
  const proxies = shuffleArray([...CORS_PROXIES]);

  for (const proxy of proxies) {
    try {
      const proxiedUrl = `${proxy}${encodeURIComponent(url)}`;
      const resp = await fetch(proxiedUrl, {
        signal: controller.signal,
        headers: { 'Accept': 'text/html,application/xhtml+xml,*/*' },
      });
      clearTimeout(timer);
      if (resp.ok) return resp;
      console.warn(`CORS proxy ${proxy.slice(0, 30)}… returned ${resp.status} for ${url.slice(0, 60)}`);
    } catch (err) {
      console.warn(`CORS proxy ${proxy.slice(0, 30)}… failed for ${url.slice(0, 60)}:`, (err as Error).message?.slice(0, 80));
    }
  }

  // Last resort: direct fetch (works for some CORS-friendly sites)
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      mode: 'cors',
      headers: { 'Accept': 'text/html,application/xhtml+xml,*/*' },
    });
    clearTimeout(timer);
    return resp;
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`All fetch methods failed for ${url}`);
  }
}

// ============================================================================
// Text Extraction (from HTML string)
// ============================================================================

/**
 * Extract clean article text from HTML using Mozilla Readability.
 * Falls back to manual DOM scraping if Readability can't parse the page.
 *
 * Readability strips navigation, ads, sidebars, footers, related articles,
 * and cookie banners — exactly the boilerplate that wastes LLM tokens.
 * Typical savings: 15,000 chars → 2,000–5,000 chars.
 *
 * MAX_CHARS is 6,000 (vs old 15,000) — sufficient for a full article while
 * reducing token cost by ~60%.
 */
function extractTextFromHtml(html: string, maxChars = 6000): string {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // --- Strategy 1: Mozilla Readability (best for articles, news, bios) ---
    // Clone document because Readability mutates the DOM
    const docClone = doc.cloneNode(true) as Document;
    const reader = new Readability(docClone, {
      charThreshold: 100,   // minimum chars for a content block to be kept
      keepClasses: false,
    });
    const article = reader.parse();

    if (article?.textContent && article.textContent.trim().length > 200) {
      const cleaned = article.textContent
        .replace(/\s+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      return cleaned.slice(0, maxChars);
    }

    // --- Strategy 2: Manual extraction (campaign sites, government pages, SPAs) ---
    // Readability fails on pages with little long-form prose (e.g. campaign site with bullet points)
    const removeTags = ['script', 'style', 'nav', 'footer', 'header', 'noscript', 'svg', 'iframe', 'aside', 'form', '.cookie-banner', '#cookie-notice', '.ad', '.advertisement'];
    for (const tag of removeTags) {
      doc.querySelectorAll(tag).forEach(el => el.remove());
    }

    // Prefer semantic content containers
    const mainContent = doc.querySelector(
      'main, article, [role="main"], .content, #content, .post-content, .entry-content, .bio, .about, .candidate-bio, .page-content'
    );
    const root = mainContent || doc.body;
    if (!root) return '';

    const text = (root.textContent || '')
      .replace(/\s+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return text.slice(0, maxChars);
  } catch {
    return '';
  }
}

function extractTitleFromHtml(html: string): string {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Try og:title first, then <title>
    const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
    if (ogTitle) return ogTitle.trim();

    return doc.title?.trim() || '';
  } catch {
    return '';
  }
}

// ============================================================================
// Search: DuckDuckGo (HTML endpoint — no API key needed)
// ============================================================================

/**
 * Parse DDG HTML response using DOM selectors with multiple fallbacks.
 * DuckDuckGo periodically changes their HTML class names, so we try
 * several known selector patterns before falling back to regex.
 */
function parseDdgResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Strategy 1: Classic DDG lite selectors (BEM-style)
    let links = doc.querySelectorAll('.result__a, .result__title a, a.result-link');

    // Strategy 2: Newer DDG selectors (observed in recent DDG HTML)
    if (links.length === 0) {
      links = doc.querySelectorAll('.results .result a[href*="uddg="], .web-result a[href], .links_main a');
    }

    // Strategy 3: Broadest — any link inside a result-like container
    if (links.length === 0) {
      links = doc.querySelectorAll('[class*="result"] a[href*="uddg="], [class*="result"] a[href*="http"]');
    }

    links.forEach(link => {
      if (results.length >= maxResults) return;
      const href = link.getAttribute('href');
      if (!href) return;

      let realUrl = href;
      try {
        const parsed = new URL(href, 'https://duckduckgo.com');
        const uddg = parsed.searchParams.get('uddg');
        if (uddg) realUrl = decodeURIComponent(uddg);
      } catch {
        // Use href as-is
      }

      // Skip DDG internal links and anchors
      if (realUrl.includes('duckduckgo.com') || realUrl.startsWith('#') || realUrl.startsWith('/')) return;
      // Must be an actual URL
      if (!realUrl.startsWith('http')) return;

      // Try multiple snippet selectors
      const parentResult = link.closest('.result, [class*="result"], .web-result');
      const snippet =
        parentResult?.querySelector('.result__snippet, .result-snippet, [class*="snippet"]')?.textContent?.trim() ||
        parentResult?.querySelector('td:nth-child(2)')?.textContent?.trim() || // DDG lite table layout
        '';
      const title = link.textContent?.trim() || realUrl;

      results.push({ title, url: realUrl, snippet });
    });
  } catch (err) {
    console.warn('DDG DOM parsing failed:', err);
  }

  // Strategy 4: Regex fallback — extract uddg= URLs directly from raw HTML
  if (results.length === 0) {
    try {
      const uddgRegex = /uddg=([^&"']+)/g;
      let match: RegExpExecArray | null;
      while ((match = uddgRegex.exec(html)) !== null && results.length < maxResults) {
        try {
          const url = decodeURIComponent(match[1]);
          if (url.startsWith('http') && !url.includes('duckduckgo.com')) {
            // Check we haven't already added this URL
            if (!results.some(r => r.url === url)) {
              results.push({ title: url, url, snippet: '' });
            }
          }
        } catch { /* skip bad URLs */ }
      }
    } catch (err) {
      console.warn('DDG regex fallback failed:', err);
    }
  }

  return results;
}

async function searchDuckDuckGo(query: string, maxResults = 8): Promise<SearchResult[]> {
  try {
    const isDev = typeof window !== 'undefined' && (window.location?.hostname === 'localhost' || window.location?.hostname === '127.0.0.1');
    const url = isDev
      ? `/api/ddg?q=${encodeURIComponent(query)}`
      : `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    const resp = isDev
      ? await fetch(url, { headers: { 'Accept': 'text/html,application/xhtml+xml,*/*' } })
      : await fetchViaCorsProxy(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, 12000);
    const html = await resp.text();

    // Diagnostic: log DDG response summary to help debug 0-result issues
    if (html.length < 500) {
      console.warn(`[DDG] Very short response (${html.length} chars) — may be blocked or challenge page`);
    }
    // Detect common bot-block patterns
    if (html.includes('bot') && html.includes('detected') || html.includes('captcha') || html.includes('unusual traffic')) {
      console.warn(`[DDG] Bot detection / CAPTCHA detected in response`);
    }

    const results = parseDdgResults(html, maxResults);
    return results;
  } catch (err) {
    console.warn('DuckDuckGo search failed:', err);
    return [];
  }
}

// ============================================================================
// Search: Google Custom Search (requires API key + engine ID)
// ============================================================================

async function searchGoogleCSE(
  query: string,
  apiKey: string,
  engineId: string,
  maxResults = 10,
): Promise<SearchResult[]> {
  try {
    const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${apiKey}&cx=${engineId}&num=${Math.min(maxResults, 10)}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      console.warn('Google CSE error:', resp.status, errBody);
      return [];
    }
    const data = await resp.json();
    return (data.items || []).map((item: any) => ({
      title: item.title || '',
      url: item.link || '',
      snippet: item.snippet || '',
    }));
  } catch (err) {
    console.warn('Google CSE search failed:', err);
    return [];
  }
}

// ============================================================================
// Build search queries from candidate info
// ============================================================================

// Map 2-letter state abbreviations to full names for better search results
const STATE_NAMES: Record<string, string> = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',
  CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',
  IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',
  ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',
  MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',
  NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',
  OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',
  TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',
  WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',DC:'District of Columbia',
};

function buildSearchQueries(name: string, meta?: CandidateMetadata): string[] {
  const queries: string[] = [];
  const office = meta?.officeName || '';
  const stateAbbr = meta?.state || '';
  const state = STATE_NAMES[stateAbbr.toUpperCase()] || stateAbbr;
  const party = meta?.party || '';
  const district = meta?.districtName || '';
  const electionYear = meta?.election?.match(/^\d{4}/)?.[0] || '';
  const partyLabel = party === 'R' ? 'Republican' : party === 'D' ? 'Democrat' :
    party === 'L' ? 'Libertarian' : party === 'G' ? 'Green' : party === 'I' ? 'Independent' : '';

  // ── Smart name variant generation ──
  // Handles: leading initials ("M. Monica Singh"), middle initials ("Donald M. Brown"),
  // suffixes ("Jr.", "III"), and first+last-only fallbacks.
  const nameVariants = [name];
  const suffixPattern = /\s+(?:Jr\.?|Sr\.?|II|III|IV|V|Esq\.?|Ph\.?D\.?)$/i;
  const nameWithoutSuffix = name.replace(suffixPattern, '').trim();
  if (nameWithoutSuffix !== name) nameVariants.push(nameWithoutSuffix);

  const parts = nameWithoutSuffix.split(/\s+/);

  // Detect leading initial: "M. Monica Singh" → "Monica Singh"
  if (parts.length >= 2 && /^[A-Z]\.?$/.test(parts[0])) {
    const withoutLeadingInitial = parts.slice(1).join(' ');
    if (!nameVariants.includes(withoutLeadingInitial)) nameVariants.push(withoutLeadingInitial);
  }

  // Detect middle initial(s): "Donald M. Brown" → "Donald Brown"
  const nameWithoutMiddle = nameWithoutSuffix.replace(/\s+[A-Z]\.?\s+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (nameWithoutMiddle !== nameWithoutSuffix && !nameVariants.includes(nameWithoutMiddle)) {
    nameVariants.push(nameWithoutMiddle);
  }

  // Combined: strip both leading initial AND middle initials if present
  if (parts.length >= 3 && /^[A-Z]\.?$/.test(parts[0])) {
    const afterLeading = parts.slice(1);
    const combined = afterLeading.filter(p => !/^[A-Z]\.?$/.test(p)).join(' ');
    if (combined && !nameVariants.includes(combined)) nameVariants.push(combined);
  }

  // First + Last only (skip all middle parts): "Mary Catherine O'Brien" → "Mary O'Brien"
  const firstName = parts[0] || '';
  const lastName = parts[parts.length - 1] || '';
  if (parts.length > 2) {
    const firstLast = `${firstName} ${lastName}`;
    if (!nameVariants.includes(firstLast)) nameVariants.push(firstLast);
  }

  // ── Core identity queries (use all name variants) ──
  for (const n of nameVariants) {
    queries.push(`"${n}" ${office} ${state} ${electionYear} candidate`.trim());
    queries.push(`"${n}" ${state} ${electionYear} campaign`.trim());
  }

  // ── Campaign website — multiple patterns ──
  queries.push(`"${name}" campaign website ${state} ${electionYear}`.trim());
  // Common campaign URL patterns: "lastname for office", "firstname lastname for office"
  if (office) {
    const officeShort = office.replace(/\b(county|district|circuit|court|state)\b/gi, '').trim();
    queries.push(`${firstName} ${lastName} for ${officeShort} ${state} ${electionYear}`.trim());
  }

  // ── Per-platform social media (use all variants for broader coverage) ──
  for (const n of nameVariants) {
    queries.push(`"${n}" ${state} ${office} site:facebook.com`.trim());
    queries.push(`"${n}" ${state} site:twitter.com OR site:x.com`.trim());
  }
  queries.push(`"${name}" ${state} ${office} site:instagram.com`.trim());
  queries.push(`"${name}" site:linkedin.com/in`.trim());
  queries.push(`"${name}" ${state} ${office} site:youtube.com`.trim());

  // ── Ballotpedia discovery (OK for finding links — NOT for citing as a source) ──
  queries.push(`"${name}" ${state} site:ballotpedia.org`.trim());

  // ── News from low-bias outlets ──
  for (const n of nameVariants) {
    queries.push(`"${n}" ${office} ${state} ${electionYear} site:apnews.com OR site:reuters.com OR site:npr.org OR site:pbs.org`.trim());
  }
  // Local news
  queries.push(`"${name}" ${office} ${state} ${electionYear} newspaper OR gazette OR tribune OR herald`.trim());

  // ── State-specific news sources ──
  const stateNewsMap: Record<string, string> = {
    TX: 'site:texastribune.org OR site:dallasnews.com OR site:houstonchronicle.com OR site:statesman.com',
    CA: 'site:latimes.com OR site:sfchronicle.com OR site:sacbee.com OR site:calmatters.org',
    FL: 'site:tampabay.com OR site:sun-sentinel.com OR site:miamiherald.com',
    NY: 'site:nytimes.com OR site:gothamist.com OR site:nydailynews.com',
    PA: 'site:pennlive.com OR site:inquirer.com OR site:post-gazette.com',
    OH: 'site:cleveland.com OR site:dispatch.com OR site:cincinnati.com',
    GA: 'site:ajc.com OR site:savannahnow.com',
    MI: 'site:freep.com OR site:mlive.com OR site:detroitnews.com',
    NC: 'site:newsobserver.com OR site:charlotteobserver.com',
    VA: 'site:richmond.com OR site:pilotonline.com OR site:virginiamercury.com',
    AZ: 'site:azcentral.com OR site:tucson.com',
    WI: 'site:jsonline.com OR site:madison.com',
    MN: 'site:startribune.com OR site:twincities.com',
    CO: 'site:denverpost.com OR site:coloradosun.com',
    IL: 'site:chicagotribune.com OR site:suntimes.com',
  };
  if (stateAbbr && stateNewsMap[stateAbbr.toUpperCase()]) {
    queries.push(`"${name}" ${office} ${electionYear} ${stateNewsMap[stateAbbr.toUpperCase()]}`.trim());
  }

  // ── News with party context ──
  if (district) {
    queries.push(`"${name}" "${district}" ${state} ${electionYear} election`.trim());
  } else {
    queries.push(`"${name}" ${state} ${partyLabel} ${electionYear} election news`.trim());
  }

  // ── Broader unquoted searches (catches partial name matches and variant spellings) ──
  for (const n of nameVariants) {
    queries.push(`${n} ${office} ${state} ${electionYear}`.trim());
  }
  // First+last only unquoted (broadest match)
  if (parts.length > 2) {
    queries.push(`${firstName} ${lastName} ${office} ${state} ${electionYear}`.trim());
  }

  // ── Government / official record searches ──
  if (office && state) {
    for (const n of nameVariants) {
      queries.push(`"${n}" "${office}" "${state}" ${electionYear}`.trim());
    }
    // State legislature / court records
    if (office.toLowerCase().includes('judge') || office.toLowerCase().includes('justice') || office.toLowerCase().includes('court')) {
      queries.push(`"${name}" ${state} court judge biography OR profile`.trim());
      queries.push(`"${name}" ${state} bar association`.trim());
    }
    if (office.toLowerCase().includes('representative') || office.toLowerCase().includes('senator') || office.toLowerCase().includes('legislature')) {
      queries.push(`"${name}" ${state} legislature OR capitol`.trim());
    }
  }

  return queries;
}

// ============================================================================
// Source bias tier classification
// ============================================================================

const TIER1_DOMAINS = [
  'apnews.com', 'reuters.com', 'pbs.org', 'npr.org', 'cspan.org', 'c-span.org',
  '.gov', '.state.', 'congress.gov', 'senate.gov', 'house.gov',
];
const TIER2_DOMAINS = [
  // National papers & wire services
  'nytimes.com', 'washingtonpost.com', 'wsj.com', 'usatoday.com', 'politico.com',
  'thehill.com', 'axios.com', 'bbc.com', 'bbc.co.uk', 'nbcnews.com', 'cbsnews.com',
  'abcnews.go.com', 'latimes.com',
  // Major regional papers
  'bostonglobe.com', 'chicagotribune.com', 'dallasnews.com', 'sfchronicle.com',
  'seattletimes.com', 'miamiherald.com', 'denverpost.com', 'startribune.com',
  'jsonline.com', 'dispatch.com', 'newsobserver.com', 'charlotteobserver.com',
  // Additional regional outlets
  'tampabay.com', 'azcentral.com', 'star-telegram.com', 'oregonlive.com',
  'tennessean.com', 'courier-journal.com', 'cleveland.com', 'pennlive.com',
  'mlive.com', 'nj.com', 'desmoinesregister.com', 'freep.com', 'indystar.com',
  'statesman.com', 'sacbee.com', 'kansascity.com', 'omaha.com', 'al.com',
  'postandcourier.com', 'pilotonline.com', 'richmond.com', 'stltoday.com',
  'mercurynews.com', 'sun-sentinel.com', 'baltimoresun.com', 'ajc.com',
  'twincities.com', 'detroitnews.com', 'oklahoman.com', 'arkansasonline.com',
  // Generic local paper substrings
  'gazette', 'tribune', 'herald', 'times', 'post', 'journal', 'observer',
  'news-record',
];
const TIER3_DOMAINS = [
  'foxnews.com', 'cnn.com', 'msnbc.com', 'breitbart.com', 'huffpost.com',
  'dailywire.com', 'theblaze.com', 'vox.com', 'slate.com', 'salon.com',
  'thedailybeast.com', 'nationalreview.com', 'motherjones.com',
  // Additional partisan / editorial-heavy outlets
  'theintercept.com', 'jacobin.com', 'reason.com', 'washingtontimes.com',
  'washingtonexaminer.com', 'newsmax.com', 'oann.com',
];
const PROHIBITED_DOMAINS = [
  'ballotready.org', 'votesmart.org', 'wikipedia.org',
];

function getSourceBiasTier(url: string): 1 | 2 | 3 | 4 {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (PROHIBITED_DOMAINS.some(d => hostname.includes(d))) return 4;
    if (TIER1_DOMAINS.some(d => hostname.includes(d) || hostname.endsWith(d))) return 1;
    if (TIER2_DOMAINS.some(d => hostname.includes(d))) return 2;
    if (TIER3_DOMAINS.some(d => hostname.includes(d))) return 3;
    return 4; // unknown
  } catch {
    return 4;
  }
}

// ============================================================================
// Fetch & extract a single page
// ============================================================================

async function fetchPage(url: string): Promise<FetchedPage> {
  const fetchedAt = new Date().toISOString();
  try {
    const resp = await fetchViaCorsProxy(url);
    const html = await resp.text();
    const text = extractTextFromHtml(html);
    const title = extractTitleFromHtml(html) || new URL(url).hostname;

    return {
      url,
      title,
      text,
      fetchedAt,
      byteLength: html.length,
      biasTier: getSourceBiasTier(url),
    };
  } catch (err: any) {
    return {
      url,
      title: url,
      text: '',
      fetchedAt,
      byteLength: 0,
      error: err.message || 'Fetch failed',
      biasTier: getSourceBiasTier(url),
    };
  }
}

// ============================================================================
// Main entry point — research a candidate
// ============================================================================

export async function researchCandidate(
  name: string,
  metadata: CandidateMetadata | undefined,
  settings: AppSettings,
  userSourceUrls: string[] = [],
  onLog?: (msg: string) => void,
): Promise<ResearchResult> {
  const log = onLog || (() => {});
  const searchProvider = settings.searchProvider || 'duckduckgo';

  // Determine actual provider — warn if falling back from Google CSE
  const useGoogleCSE = searchProvider === 'google-cse' && settings.googleSearchApiKey && settings.googleSearchEngineId;
  const actualProvider = useGoogleCSE ? 'Google CSE' : 'DuckDuckGo';
  if (searchProvider === 'google-cse' && !useGoogleCSE) {
    log(`⚠️ Google CSE selected but missing API key or Engine ID — falling back to DuckDuckGo`);
  }

  // 1. Build queries
  const queries = buildSearchQueries(name, metadata);
  log(`🔎 Research phase: ${queries.length} search queries prepared (via ${actualProvider})`);

  // Log the name variants discovered for debugging search issues
  const variantCheck = (() => {
    const parts = name.split(/\s+/);
    const variants = [name];
    const suffixPattern = /\s+(?:Jr\.?|Sr\.?|II|III|IV|V|Esq\.?|Ph\.?D\.?)$/i;
    const noSuffix = name.replace(suffixPattern, '').trim();
    if (noSuffix !== name) variants.push(noSuffix);
    const p = noSuffix.split(/\s+/);
    if (p.length >= 2 && /^[A-Z]\.?$/.test(p[0])) variants.push(p.slice(1).join(' '));
    return variants;
  })();
  if (variantCheck.length > 1) {
    log(`   📝 Name variants: ${variantCheck.join(', ')}`);
  }

  // 2. Run searches with retry logic & exponential backoff
  let allSearchResults: SearchResult[] = [];
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 5; // circuit breaker threshold
  const CIRCUIT_BREAKER_PAUSE_MS = 10000; // 10s pause when circuit trips

  for (let qi = 0; qi < queries.length; qi++) {
    const query = queries[qi];
    log(`🔍 [${actualProvider}] Searching: ${query}`);

    let results: SearchResult[] = [];
    if (useGoogleCSE) {
      results = await searchGoogleCSE(query, settings.googleSearchApiKey!, settings.googleSearchEngineId!, 8);
    } else {
      results = await searchDuckDuckGo(query, 8);

      // Retry once on empty results with a longer delay
      if (results.length === 0 && consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        results = await searchDuckDuckGo(query, 8);
      }
    }

    allSearchResults.push(...results);
    log(`   Found ${results.length} result(s)`);

    if (results.length === 0) {
      consecutiveFailures++;
      log(`   ⚠ No results (${consecutiveFailures} consecutive failures)`);

      // Circuit breaker: if many consecutive failures, pause and warn
      if (consecutiveFailures === MAX_CONSECUTIVE_FAILURES) {
        log(`   ⏸ ${MAX_CONSECUTIVE_FAILURES} consecutive failures — pausing ${CIRCUIT_BREAKER_PAUSE_MS / 1000}s before continuing`);
        await new Promise(resolve => setTimeout(resolve, CIRCUIT_BREAKER_PAUSE_MS));
      }
    } else {
      consecutiveFailures = 0; // reset on success
    }

    // Exponential backoff between queries: 1s base, doubles on failures, caps at 5s
    const baseDelay = 1000;
    const backoffDelay = Math.min(baseDelay * Math.pow(1.5, Math.min(consecutiveFailures, 4)), 5000);
    await new Promise(resolve => setTimeout(resolve, backoffDelay));
  }

  // 3. Deduplicate URLs
  const seenUrls = new Set<string>();
  const uniqueResults: SearchResult[] = [];
  for (const r of allSearchResults) {
    // Normalize URL for dedup
    const normalized = r.url.replace(/\/+$/, '').toLowerCase();
    if (seenUrls.has(normalized)) continue;
    seenUrls.add(normalized);
    uniqueResults.push(r);
  }

  // Add user-provided URLs (if not already found)
  for (const url of userSourceUrls) {
    const normalized = url.replace(/\/+$/, '').toLowerCase();
    if (!seenUrls.has(normalized)) {
      seenUrls.add(normalized);
      uniqueResults.push({ title: url, url, snippet: '(user-provided source)' });
    }
  }

  log(`📋 ${uniqueResults.length} unique URL(s) to fetch (${userSourceUrls.length} user-provided)`);

  // Detect total search failure — all queries returned 0 results
  const searchFailure = allSearchResults.length === 0 && userSourceUrls.length === 0;
  if (searchFailure) {
    log(`❌ All ${queries.length} searches returned 0 results. ${actualProvider} may be blocked or rate-limited.`);
    if (actualProvider === 'DuckDuckGo') {
      log(`💡 Tip: Switch to Google Custom Search in Settings → Web Research for more reliable results.`);
    }
  }

  // 4a. Filter out prohibited domains entirely — don't fetch Ballotpedia/VoteSmart/Wikipedia.
  //     The Writer is already instructed never to cite them, but sending their HTML to the LLM
  //     wastes tokens and risks content contamination.
  const filteredResults = uniqueResults.filter(r => {
    try {
      const hostname = new URL(r.url).hostname.toLowerCase();
      return !PROHIBITED_DOMAINS.some(d => hostname.includes(d));
    } catch { return false; }
  });
  const prohibitedSkipped = uniqueResults.length - filteredResults.length;
  if (prohibitedSkipped > 0) {
    log(`⛔ Skipping ${prohibitedSkipped} prohibited URL(s) (Ballotpedia/VoteSmart/Wikipedia)`);
  }

  // 4b. Sort by source trust tier BEFORE slicing so the best sources fill fetch slots.
  //     Without this, a "ballotpedia" search query at position 0 would have eaten the first 8 slots.
  const sortedResults = [...filteredResults].sort(
    (a, b) => getSourceBiasTier(a.url) - getSourceBiasTier(b.url),
  );

  // 4c. Limit to top 25 after filtering + sorting.
  const urlsToFetch = sortedResults.slice(0, 25);
  const pages: FetchedPage[] = [];
  let totalFailed = 0;

  for (const sr of urlsToFetch) {
    log(`🌐 Fetching: ${sr.url}`);
    const page = await fetchPage(sr.url);
    if (page.error) {
      log(`   ⚠ Failed: ${page.error}`);
      totalFailed++;
    } else {
      log(`   📄 Extracted ${page.text.length.toLocaleString()} chars from ${page.title}`);
    }
    pages.push(page);
  }

  const successPages = pages.filter(p => !p.error && p.text.length > 50);
  log(`✅ Research complete: ${successPages.length} page(s) fetched, ${totalFailed} failed`);

  return {
    pages,
    searchQueries: queries,
    searchResults: uniqueResults,
    userProvidedUrls: userSourceUrls,
    totalFetched: successPages.length,
    totalFailed,
    searchFailure,
  };
}

// ============================================================================
// Format research results as source content for the Writer
// ============================================================================

export function formatResearchAsSourceContent(research: ResearchResult): string {
  const sections: string[] = [];

  // List all successful source URLs for the Writer to cite
  const successPages = research.pages.filter(p => !p.error && p.text.length > 50);

  if (successPages.length === 0) {
    return '(No source material found from web research)';
  }

  // Sort by bias tier — most trustworthy sources first
  const sorted = [...successPages].sort((a, b) => (a.biasTier || 4) - (b.biasTier || 4));

  // ── Deduplication: drop near-duplicate articles (e.g. AP wire syndicated content) ──
  // Fingerprint = first 300 chars of text, lowercased and whitespace-normalised.
  // If two pages share a fingerprint, keep only the higher-trust source.
  const seenFingerprints = new Set<string>();
  const deduped: FetchedPage[] = [];
  let droppedDupes = 0;
  for (const page of sorted) {
    const fingerprint = page.text
      .slice(0, 300)
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    if (!seenFingerprints.has(fingerprint)) {
      seenFingerprints.add(fingerprint);
      deduped.push(page);
    } else {
      droppedDupes++;
    }
  }

  const TIER_LABELS: Record<number, string> = { 1: 'Tier 1 (most trusted)', 2: 'Tier 2 (major news)', 3: 'Tier 3 (partisan)', 4: 'Tier 4 (unranked)' };

  sections.push('=== SOURCE MATERIAL ===');
  sections.push(`The following content was retrieved from the web. You may ONLY cite URLs listed here.`);
  sections.push(`Sources are ordered by trustworthiness. Prefer Tier 1–2 sources over Tier 3–4.`);
  if (droppedDupes > 0) {
    sections.push(`(${droppedDupes} duplicate/syndicated article(s) removed)\n`);
  } else {
    sections.push('');
  }

  for (const page of deduped) {
    const tierLabel = TIER_LABELS[page.biasTier || 4];
    sections.push(`--- SOURCE: ${page.url} [${tierLabel}] ---`);
    sections.push(`Title: ${page.title}`);
    sections.push(`Fetched: ${page.fetchedAt}`);
    sections.push(`Content:\n${page.text}`);
    sections.push('');
  }

  // Also include search-result snippets for pages that failed to fetch
  const failedWithSnippets = research.searchResults.filter(sr => {
    const fetched = research.pages.find(p => p.url === sr.url);
    return (!fetched || fetched.error) && sr.snippet;
  });

  if (failedWithSnippets.length > 0) {
    sections.push('--- ADDITIONAL SEARCH SNIPPETS (pages could not be fetched) ---');
    sections.push('These are search-engine snippets. Do NOT cite these URLs unless content above already covers them.\n');
    for (const sr of failedWithSnippets.slice(0, 5)) {
      sections.push(`URL: ${sr.url}`);
      sections.push(`Snippet: ${sr.snippet}`);
      sections.push('');
    }
  }

  return sections.join('\n');
}
