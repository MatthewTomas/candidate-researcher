/**
 * URL Validator — checks whether cited URLs actually exist and optionally
 * verifies that quoted text appears on the page.
 *
 * Fallback chain:
 *   1. Direct fetch (CORS may block)
 *   2. AllOrigins proxy (free CORS proxy)
 *   3. Mark as "unverifiable" (honest about what we can't check)
 *
 * This runs in the browser, so cross-origin restrictions apply.
 */

// ============================================================================
// Types
// ============================================================================

export type UrlValidationStatus = 'valid' | 'invalid' | 'unverifiable';

export interface UrlValidationResult {
  url: string;
  status: UrlValidationStatus;
  httpStatus?: number;
  quoteFound?: boolean;
  /** Which method succeeded */
  method: 'direct' | 'proxy' | 'none';
  /** Error message if failed */
  error?: string;
  /** Snippet of fetched content (first 200 chars) for debugging */
  fetchedSnippet?: string;
}

export interface QuoteValidationResult {
  found: boolean;
  /** Closest match score (0-1) if fuzzy matching was used */
  similarity?: number;
}

// ============================================================================
// Quote Matching
// ============================================================================

/**
 * Normalize text for comparison:
 * - collapse whitespace
 * - lowercase
 * - remove common punctuation variations
 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u201C\u201D]/g, '"') // smart quotes → regular
    .replace(/[\u2013\u2014]/g, '-') // em/en dash → hyphen
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check whether a direct quote appears in page content.
 * Uses normalized fuzzy substring matching.
 */
export function validateQuote(pageContent: string, directQuote: string): QuoteValidationResult {
  if (!directQuote || !pageContent) return { found: false };

  const normalizedContent = normalizeText(pageContent);
  const normalizedQuote = normalizeText(directQuote);

  // Exact substring match (after normalization)
  if (normalizedContent.includes(normalizedQuote)) {
    return { found: true, similarity: 1.0 };
  }

  // Try with shorter segments (in case of slight rewording)
  // Split quote into 8-word chunks and check if any appear
  const words = normalizedQuote.split(' ');
  if (words.length >= 8) {
    const chunkSize = Math.min(8, Math.floor(words.length / 2));
    let matchedChunks = 0;
    const totalChunks = Math.ceil(words.length / chunkSize);

    for (let i = 0; i < words.length; i += chunkSize) {
      const chunk = words.slice(i, i + chunkSize).join(' ');
      if (normalizedContent.includes(chunk)) {
        matchedChunks++;
      }
    }

    const similarity = matchedChunks / totalChunks;
    return { found: similarity >= 0.5, similarity };
  }

  return { found: false, similarity: 0 };
}

// ============================================================================
// URL Validation
// ============================================================================

/**
 * Extract visible text from HTML (strip tags).
 */
function extractTextFromHtml(html: string): string {
  // Simple tag stripping — we don't need a full DOM parser
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Try to fetch a URL directly (may fail due to CORS).
 */
async function fetchDirect(url: string, signal: AbortSignal): Promise<{ ok: boolean; status: number; text?: string }> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      mode: 'cors',
      signal,
      headers: { 'Accept': 'text/html,application/xhtml+xml,*/*' },
    });
    if (response.ok) {
      const text = await response.text();
      return { ok: true, status: response.status, text };
    }
    return { ok: false, status: response.status };
  } catch {
    throw new Error('CORS or network error');
  }
}

/**
 * Try to fetch a URL via AllOrigins CORS proxy.
 */
async function fetchViaProxy(url: string, signal: AbortSignal): Promise<{ ok: boolean; status: number; text?: string }> {
  const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
  const response = await fetch(proxyUrl, { signal });
  if (!response.ok) {
    return { ok: false, status: response.status };
  }
  const data = await response.json();
  if (data.status?.http_code && data.status.http_code >= 400) {
    return { ok: false, status: data.status.http_code };
  }
  return { ok: true, status: data.status?.http_code || 200, text: data.contents };
}

/**
 * Validate a single URL with the fallback chain:
 * direct → proxy → unverifiable.
 *
 * Optionally checks if a direct quote appears on the page.
 */
export async function validateUrl(
  url: string,
  directQuote?: string,
  timeoutMs = 10000,
): Promise<UrlValidationResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // --- Attempt 1: Direct fetch ---
    try {
      const result = await fetchDirect(url, controller.signal);
      if (result.ok && result.text) {
        const pageText = extractTextFromHtml(result.text);
        const quoteResult = directQuote ? validateQuote(pageText, directQuote) : undefined;
        return {
          url,
          status: 'valid',
          httpStatus: result.status,
          quoteFound: quoteResult?.found,
          method: 'direct',
          fetchedSnippet: pageText.slice(0, 200),
        };
      }
      if (!result.ok) {
        return {
          url,
          status: 'invalid',
          httpStatus: result.status,
          method: 'direct',
          error: `HTTP ${result.status}`,
        };
      }
    } catch {
      // CORS blocked — try proxy
    }

    // --- Attempt 2: Proxy fetch ---
    try {
      const result = await fetchViaProxy(url, controller.signal);
      if (result.ok && result.text) {
        const pageText = extractTextFromHtml(result.text);
        const quoteResult = directQuote ? validateQuote(pageText, directQuote) : undefined;
        return {
          url,
          status: 'valid',
          httpStatus: result.status,
          quoteFound: quoteResult?.found,
          method: 'proxy',
          fetchedSnippet: pageText.slice(0, 200),
        };
      }
      if (!result.ok) {
        return {
          url,
          status: 'invalid',
          httpStatus: result.status,
          method: 'proxy',
          error: `HTTP ${result.status}`,
        };
      }
    } catch {
      // Proxy also failed
    }

    // --- Attempt 3: Unverifiable ---
    return {
      url,
      status: 'unverifiable',
      method: 'none',
      error: 'Could not reach URL (CORS blocked, proxy failed)',
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Validate multiple URLs in parallel with a concurrency limit.
 */
export async function validateAllUrls(
  urls: string[],
  quotes?: Map<string, string>,
  concurrency = 5,
  timeoutMs = 10000,
): Promise<UrlValidationResult[]> {
  const results: UrlValidationResult[] = [];
  const queue = [...urls];

  async function worker() {
    while (queue.length > 0) {
      const url = queue.shift()!;
      const quote = quotes?.get(url);
      const result = await validateUrl(url, quote, timeoutMs);
      results.push(result);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, () => worker());
  await Promise.all(workers);

  return results;
}
