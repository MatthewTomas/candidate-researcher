/**
 * Source Verifier — AI-assisted verification of stance/bio sources.
 *
 * For each source in a stance or bio:
 *   1. Fetch the cited URL (via CORS proxy)
 *   2. Extract page text
 *   3. Ask an AI provider to check:
 *      a) Does the exact quote (or close paraphrase) exist on the page?
 *      b) Does the quote support the claimed stance/fact?
 *      c) Is the content about the correct candidate?
 *   4. Return a confidence score (0–1) with explanation
 */

import type { AIProvider } from './aiProvider';
import type { Source, Stance, Bio, StagingDraft } from '../types';

// Reuse CORS proxy + text extraction from webResearch
// We import the module dynamically to avoid circular deps — but the functions
// we need are the same pattern. Inline them here for independence.

const CORS_PROXIES = [
  'https://corsproxy.io/?',
  'https://api.allorigins.win/raw?url=',
];

// ============================================================================
// Types
// ============================================================================

export interface SourceVerification {
  url: string;
  quoteFound: boolean;
  quoteSupportsStance: boolean;
  aboutCorrectCandidate: boolean;
  confidence: number;          // 0–1
  confidenceReason: string;
  pageTitle?: string;
  fetchError?: string;
}

export interface VerifyDraftResult {
  /** Updated draft with confidence scores written back to sources/stances/bios */
  draft: Partial<StagingDraft>;
  /** Individual verification results for logging */
  results: SourceVerification[];
  /** Summary stats */
  totalSources: number;
  verified: number;
  lowConfidence: number;
  fetchFailed: number;
}

// ============================================================================
// Fetch helpers (self-contained for independence from webResearch.ts)
// ============================================================================

async function fetchViaCorsProxy(url: string, timeoutMs = 10000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  for (const proxy of CORS_PROXIES) {
    try {
      const proxiedUrl = `${proxy}${encodeURIComponent(url)}`;
      const resp = await fetch(proxiedUrl, {
        signal: controller.signal,
        headers: { 'Accept': 'text/html,application/xhtml+xml,*/*' },
      });
      clearTimeout(timer);
      if (resp.ok) return resp;
    } catch {
      // try next proxy
    }
  }

  // Direct fetch fallback
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'text/html,*/*' },
    });
    clearTimeout(timer);
    if (resp.ok) return resp;
    throw new Error(`HTTP ${resp.status}`);
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`All fetch methods failed for ${url}`);
  }
}

function extractTextFromHtml(html: string, maxChars = 20000): string {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const removeTags = ['script', 'style', 'nav', 'footer', 'header', 'noscript', 'svg', 'iframe'];
    for (const tag of removeTags) {
      doc.querySelectorAll(tag).forEach(el => el.remove());
    }
    const mainContent = doc.querySelector('main, article, [role="main"], .content, #content');
    const root = mainContent || doc.body;
    if (!root) return '';
    const text = root.textContent || '';
    return text.replace(/\s+/g, ' ').replace(/\n\s*\n/g, '\n').trim().slice(0, maxChars);
  } catch {
    return '';
  }
}

function extractTitle(html: string): string {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
    return ogTitle?.trim() || doc.title?.trim() || '';
  } catch {
    return '';
  }
}

// ============================================================================
// Fetch page text for verification
// ============================================================================

async function fetchPageText(url: string): Promise<{ text: string; title: string; error?: string }> {
  try {
    const resp = await fetchViaCorsProxy(url);
    const html = await resp.text();
    const text = extractTextFromHtml(html);
    const title = extractTitle(html) || new URL(url).hostname;
    if (text.length < 30) {
      return { text: '', title, error: 'Page returned too little text content' };
    }
    return { text, title };
  } catch (err: any) {
    return { text: '', title: '', error: err.message || 'Fetch failed' };
  }
}

// ============================================================================
// AI-assisted source verification
// ============================================================================

async function verifyOneSource(
  provider: AIProvider,
  source: Source,
  claimText: string,
  candidateName: string,
  pageText: string,
  pageTitle: string,
): Promise<SourceVerification> {
  const prompt = `You are a fact-checking assistant. Verify a source citation for a candidate profile.

CANDIDATE: "${candidateName}"
CLAIMED STANCE/FACT: "${claimText}"
CITED URL: ${source.url}
EXPECTED QUOTE: "${source.directQuote}"
PAGE TITLE: "${pageTitle}"

PAGE CONTENT (extracted):
---
${pageText.slice(0, 12000)}
---

CHECK ALL THREE:
1. QUOTE CHECK: Does the expected quote (or a very close paraphrase with the same meaning) appear in the page content? Be flexible with whitespace and minor formatting differences, but the core words must match.
2. STANCE SUPPORT: Does the quote/page content actually support the claimed stance or fact? The quote should be direct evidence for the claim.
3. IDENTITY CHECK: Is this page content about "${candidateName}" specifically? Watch for namesakes, different election cycles, or content about entirely different people.

RESPOND WITH JSON ONLY:
{
  "quoteFound": true/false,
  "quoteSupportsStance": true/false,
  "aboutCorrectCandidate": true/false,
  "confidence": 0.0 to 1.0,
  "reason": "Brief explanation of your findings"
}

Scoring guidance:
- All three true → confidence 0.85–1.0
- Quote found + supports stance but unsure about candidate → 0.6–0.8
- Quote not exact but paraphrase found + supports stance → 0.5–0.7
- Quote not found at all → 0.1–0.3
- Wrong candidate → 0.0–0.1`;

  try {
    const responseText = await provider.generateText(prompt, {
      temperature: 0.1,
      maxTokens: 1024,
    });

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    const parsed = JSON.parse(jsonMatch[0]);

    return {
      url: source.url,
      quoteFound: Boolean(parsed.quoteFound),
      quoteSupportsStance: Boolean(parsed.quoteSupportsStance),
      aboutCorrectCandidate: Boolean(parsed.aboutCorrectCandidate),
      confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0.5)),
      confidenceReason: parsed.reason || '',
      pageTitle,
    };
  } catch (err: any) {
    return {
      url: source.url,
      quoteFound: false,
      quoteSupportsStance: false,
      aboutCorrectCandidate: false,
      confidence: 0.3,
      confidenceReason: `AI verification failed: ${err.message}`,
      pageTitle,
    };
  }
}

// ============================================================================
// Verify all sources in a draft
// ============================================================================

export async function verifyDraftSources(
  provider: AIProvider,
  draft: Partial<StagingDraft>,
  candidateName: string,
  onLog?: (msg: string) => void,
): Promise<VerifyDraftResult> {
  const log = onLog || (() => {});
  const results: SourceVerification[] = [];
  const updatedDraft = structuredClone(draft) as Partial<StagingDraft>;

  // Collect all (source, claimText) pairs from bios and stances
  interface SourceJob {
    source: Source;
    claimText: string;
    writeback: (confidence: number, reason: string) => void;
    parentWriteback?: (confidence: number, reason: string) => void;
  }

  const jobs: SourceJob[] = [];

  // Bios
  if (updatedDraft.bios) {
    for (const bio of updatedDraft.bios) {
      for (const src of bio.sources) {
        if (!src.url || !src.url.startsWith('http')) continue;
        jobs.push({
          source: src,
          claimText: bio.text,
          writeback: (c, r) => { src.confidence = c; src.confidenceReason = r; },
          parentWriteback: (c, r) => { bio.confidence = c; bio.confidenceReason = r; },
        });
      }
    }
  }

  // Stances
  if (updatedDraft.issues) {
    for (const issue of updatedDraft.issues) {
      for (const stance of issue.stances) {
        for (const src of stance.sources) {
          if (!src.url || !src.url.startsWith('http')) continue;
          jobs.push({
            source: src,
            claimText: stance.text,
            writeback: (c, r) => { src.confidence = c; src.confidenceReason = r; },
            parentWriteback: (c, r) => { stance.confidence = c; stance.confidenceReason = r; },
          });
        }
      }
    }
  }

  if (jobs.length === 0) {
    log('No sources with URLs to verify.');
    return { draft: updatedDraft, results, totalSources: 0, verified: 0, lowConfidence: 0, fetchFailed: 0 };
  }

  log(`🔬 Verifying ${jobs.length} source(s) across bios and stances…`);

  // Deduplicate URL fetches — many sources may cite the same URL
  const pageCache = new Map<string, { text: string; title: string; error?: string }>();
  const uniqueUrls = [...new Set(jobs.map(j => j.source.url))];

  log(`📥 Fetching ${uniqueUrls.length} unique URL(s)…`);
  for (const url of uniqueUrls) {
    const page = await fetchPageText(url);
    pageCache.set(url, page);
    if (page.error) {
      log(`   ⚠ Failed to fetch: ${url} — ${page.error}`);
    } else {
      log(`   ✅ Fetched: ${url} (${page.text.length.toLocaleString()} chars)`);
    }
  }

  // Verify each source
  let fetchFailed = 0;
  let lowConfidence = 0;
  let verified = 0;

  // Track parent-level confidence: group by a key that identifies the stance/bio
  const parentConfidences = new Map<string, { min: number; reason: string; writeback: (c: number, r: string) => void }>();

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const cached = pageCache.get(job.source.url);

    if (!cached || cached.error) {
      // Can't verify — page not fetchable
      const result: SourceVerification = {
        url: job.source.url,
        quoteFound: false,
        quoteSupportsStance: false,
        aboutCorrectCandidate: false,
        confidence: 0.2,
        confidenceReason: `Could not fetch page: ${cached?.error || 'unknown error'}`,
        fetchError: cached?.error,
      };
      results.push(result);
      job.writeback(0.2, result.confidenceReason);
      fetchFailed++;
      log(`   [${i + 1}/${jobs.length}] ⚠ Cannot verify (fetch failed): ${job.source.url}`);
      continue;
    }

    log(`   [${i + 1}/${jobs.length}] 🔍 Verifying: "${job.claimText.slice(0, 50)}…" against ${job.source.url}`);

    const result = await verifyOneSource(
      provider,
      job.source,
      job.claimText,
      candidateName,
      cached.text,
      cached.title,
    );
    results.push(result);
    job.writeback(result.confidence, result.confidenceReason);

    if (result.confidence >= 0.8) {
      verified++;
      log(`      ✅ Confidence: ${(result.confidence * 100).toFixed(0)}% — ${result.confidenceReason}`);
    } else if (result.confidence >= 0.5) {
      log(`      ⚠ Confidence: ${(result.confidence * 100).toFixed(0)}% — ${result.confidenceReason}`);
    } else {
      lowConfidence++;
      log(`      🚩 Low confidence: ${(result.confidence * 100).toFixed(0)}% — ${result.confidenceReason}`);
    }

    // Track parent (stance/bio) confidence — use min across sources
    if (job.parentWriteback) {
      const key = `${job.claimText.slice(0, 80)}`;
      const existing = parentConfidences.get(key);
      if (!existing || result.confidence < existing.min) {
        parentConfidences.set(key, {
          min: result.confidence,
          reason: result.confidenceReason,
          writeback: job.parentWriteback,
        });
      }
    }

    // Small delay between AI calls
    if (i < jobs.length - 1) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // Write back parent (stance/bio) confidence scores
  for (const entry of parentConfidences.values()) {
    entry.writeback(entry.min, entry.reason);
  }

  log(`🔬 Source verification complete: ${verified} high-confidence, ${lowConfidence} low-confidence, ${fetchFailed} fetch failed`);

  return {
    draft: updatedDraft,
    results,
    totalSources: jobs.length,
    verified,
    lowConfidence,
    fetchFailed,
  };
}
