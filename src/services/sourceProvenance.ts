/**
 * Source Provenance — deterministic (non-AI) URL verification.
 *
 * Checks whether URLs cited by the Writer agent actually appeared
 * in the input source material. This is the most reliable layer
 * of defense against fabricated sources because it's pure string
 * matching — no AI hallucination possible.
 */

// ============================================================================
// Types
// ============================================================================

export interface ProvenanceResult {
  /** The URL found in the Writer's output */
  url: string;
  /** Whether this URL (or a close match) appeared in the input source material */
  isFromInput: boolean;
  /** The closest matching URL from input, if any */
  closestMatch?: string;
  /** How the match was determined */
  matchType: 'exact' | 'domain-path' | 'domain-only' | 'none';
}

export interface ProvenanceSummary {
  totalUrls: number;
  fromInput: number;
  fabricated: number;
  results: ProvenanceResult[];
}

// ============================================================================
// URL Extraction
// ============================================================================

/** Pattern that matches most http/https URLs */
const URL_PATTERN = /https?:\/\/[^\s"'<>\]\)},]+/gi;

/**
 * Extract all URLs from a text string.
 * Works on raw text, HTML, or JSON-stringified content.
 */
export function extractUrls(text: string): string[] {
  if (!text) return [];
  const matches = text.match(URL_PATTERN) || [];
  // Deduplicate and clean up trailing punctuation
  const cleaned = matches.map(u => u.replace(/[.,;:!?)\]]+$/, ''));
  return [...new Set(cleaned)];
}

/**
 * Extract URLs from a structured Writer output (Partial<StagingDraft> as JSON).
 * Walks through bios, issues/stances, and links to find all cited URLs.
 */
export function extractOutputUrls(draft: Record<string, unknown>): string[] {
  const json = JSON.stringify(draft);
  return extractUrls(json);
}

/**
 * Extract URLs from the input source material.
 * This includes HTML content, additional source URLs, and any other user-provided data.
 */
export function extractInputUrls(sourceContent: string): string[] {
  return extractUrls(sourceContent);
}

// ============================================================================
// Provenance Checking
// ============================================================================

/**
 * Normalize a URL for comparison:
 * - lowercase
 * - remove trailing slashes
 * - remove www. prefix
 * - remove query params and fragments
 */
function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    return `${host}${path}`;
  } catch {
    // If URL can't be parsed, just lowercase and clean
    return url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');
  }
}

/**
 * Get just the domain from a URL.
 */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    const match = url.match(/(?:https?:\/\/)?(?:www\.)?([^\/\s]+)/i);
    return match?.[1]?.toLowerCase() || url.toLowerCase();
  }
}

/**
 * Check whether a single output URL has provenance in the input URLs.
 */
function checkSingleUrl(outputUrl: string, inputUrls: string[], inputNormalized: string[], inputDomains: string[]): ProvenanceResult {
  const normalizedOutput = normalizeUrl(outputUrl);
  const outputDomain = extractDomain(outputUrl);

  // 1. Exact match (after normalization)
  const exactIdx = inputNormalized.indexOf(normalizedOutput);
  if (exactIdx >= 0) {
    return { url: outputUrl, isFromInput: true, closestMatch: inputUrls[exactIdx], matchType: 'exact' };
  }

  // 2. Domain + path prefix match (e.g., campaign.com/issues vs campaign.com/issues/economy)
  for (let i = 0; i < inputNormalized.length; i++) {
    if (normalizedOutput.startsWith(inputNormalized[i]) || inputNormalized[i].startsWith(normalizedOutput)) {
      return { url: outputUrl, isFromInput: true, closestMatch: inputUrls[i], matchType: 'domain-path' };
    }
  }

  // 3. Domain-only match (same website, different page)
  const domainIdx = inputDomains.indexOf(outputDomain);
  if (domainIdx >= 0) {
    return { url: outputUrl, isFromInput: true, closestMatch: inputUrls[domainIdx], matchType: 'domain-only' };
  }

  // 4. No match — fabricated
  return { url: outputUrl, isFromInput: false, matchType: 'none' };
}

/**
 * Check provenance of all URLs in the Writer's output against the input source material.
 *
 * Returns a result for each output URL indicating whether it was
 * found in the input or is potentially fabricated.
 */
export function checkProvenance(outputUrls: string[], inputUrls: string[]): ProvenanceSummary {
  const inputNormalized = inputUrls.map(normalizeUrl);
  const inputDomains = inputUrls.map(extractDomain);

  const results = outputUrls.map(url => checkSingleUrl(url, inputUrls, inputNormalized, inputDomains));

  return {
    totalUrls: results.length,
    fromInput: results.filter(r => r.isFromInput).length,
    fabricated: results.filter(r => !r.isFromInput).length,
    results,
  };
}

/**
 * Get a human-readable summary of provenance results for injection into critic prompts.
 */
export function formatProvenanceForCritic(summary: ProvenanceSummary): string {
  if (summary.fabricated === 0) {
    return `SOURCE PROVENANCE CHECK: All ${summary.totalUrls} cited URLs were found in the input source material. ✅`;
  }

  const fabricatedUrls = summary.results.filter(r => !r.isFromInput);
  const lines = [
    `SOURCE PROVENANCE CHECK: ${summary.fabricated} of ${summary.totalUrls} cited URLs were NOT found in the input source material.`,
    '',
    '⚠ FABRICATED SOURCES (flag each as a "fabrication" severity issue):',
    ...fabricatedUrls.map(r => `  - ${r.url}`),
    '',
    'These URLs do not appear anywhere in the source material provided to the Writer.',
    'Each must be flagged as a fabrication — the Writer invented these sources.',
  ];
  return lines.join('\n');
}
