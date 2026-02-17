/**
 * HTML Text Extraction Service
 * 
 * Parses raw HTML from the Branch Research Portal and extracts:
 * - Candidate name, links, bio sections, issue stances, sources, quotes
 * - Produces a structured ExtractedProfile matching the Branch JSON shape
 */

import type { ExtractedProfile, LinkItem, Source, CandidateLinks, SocialPlatform } from '../types';
import DOMPurify from 'dompurify';

/**
 * Extract all meaningful text from raw HTML, stripping tags, scripts, styles.
 */
export function extractTextFromHtml(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Remove scripts, styles, and hidden elements
  const removeTags = ['script', 'style', 'noscript', 'svg', 'path', 'meta', 'link'];
  removeTags.forEach(tag => {
    doc.querySelectorAll(tag).forEach(el => el.remove());
  });

  // Remove hidden elements
  doc.querySelectorAll('[style*="display: none"], [style*="display:none"], [aria-hidden="true"], [hidden]').forEach(el => el.remove());

  // Get text content, collapse whitespace, remove empty lines
  const rawText = doc.body?.textContent ?? '';
  return rawText
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line.length > 0)
    .join('\n');
}

/**
 * Extract all links from the HTML.
 */
export function extractLinksFromHtml(html: string): LinkItem[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const links: LinkItem[] = [];
  const seen = new Set<string>();

  doc.querySelectorAll('a[href]').forEach(a => {
    const url = (a as HTMLAnchorElement).href;
    if (!url || seen.has(url) || url.startsWith('javascript:') || url === '#') return;
    seen.add(url);

    let mediaType: LinkItem['mediaType'] = 'website';
    if (url.includes('facebook.com')) mediaType = 'facebook';
    else if (url.includes('twitter.com') || url.includes('x.com')) mediaType = 'twitter';
    else if (url.includes('instagram.com')) mediaType = 'instagram';
    else if (url.includes('linkedin.com')) mediaType = 'linkedin';
    else if (url.includes('youtube.com')) mediaType = 'youtube';
    else if (url.includes('tiktok.com')) mediaType = 'tiktok';

    const accountType = inferAccountType(url, (a as HTMLAnchorElement).textContent || '');

    links.push({
      mediaType,
      url,
      title: (a as HTMLAnchorElement).textContent?.trim() || undefined,
      accountType,
    });
  });

  return links;
}

/**
 * Extract structured sections from the Branch Research Portal HTML.
 * The Branch portal renders styled-components with specific patterns:
 * - Candidate name in header areas
 * - Bio sections (personal, professional, political)
 * - Issue stances with source citations
 */
export function extractBranchProfile(html: string): ExtractedProfile {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const fullText = extractTextFromHtml(html);
  const links = extractLinksFromHtml(html);

  // Try to extract candidate name from the page
  const candidateName = extractCandidateName(doc, fullText);

  // Extract bio sections
  const bios = extractBioSections(doc, fullText);

  // Extract issues/stances
  const issues = extractIssueSections(doc, fullText);

  // Extract source citations
  const sources = extractSources(doc);

  return {
    candidateName,
    links,
    bios,
    issues,
    sources,
    rawText: fullText,
  };
}

function extractCandidateName(doc: Document, fullText: string): string {
  // Look for common patterns in headers
  const h1 = doc.querySelector('h1');
  if (h1?.textContent?.trim()) return h1.textContent.trim();

  const h2 = doc.querySelector('h2');
  if (h2?.textContent?.trim()) return h2.textContent.trim();

  // Look for title-like elements
  const title = doc.querySelector('title');
  if (title?.textContent) {
    const titleText = title.textContent.replace(/\s*[-|]\s*Branch.*$/i, '').trim();
    if (titleText) return titleText;
  }

  // Look for name patterns in the text
  const nameMatch = fullText.match(/^([A-Z][a-z]+ (?:[A-Z]\. )?[A-Z][a-z]+)/m);
  if (nameMatch) return nameMatch[1];

  return 'Unknown Candidate';
}

function extractBioSections(_doc: Document, fullText: string): ExtractedProfile['bios'] {
  const bios = { personal: '', professional: '', political: '' };

  // Look for labeled sections
  const sections = fullText.split(/\n(?=(?:Personal|Professional|Political|Background|Education|Career|Experience))/i);

  for (const section of sections) {
    const lower = section.toLowerCase();
    if (lower.startsWith('personal') || lower.includes('born') || lower.includes('education') || lower.includes('family')) {
      bios.personal += section.trim() + '\n';
    } else if (lower.startsWith('professional') || lower.includes('career') || lower.includes('currently serves')) {
      bios.professional += section.trim() + '\n';
    } else if (lower.startsWith('political') || lower.includes('ran for') || lower.includes('elected') || lower.includes('campaign')) {
      bios.political += section.trim() + '\n';
    }
  }

  // If no structured sections found, put everything in personal
  if (!bios.personal && !bios.professional && !bios.political) {
    bios.personal = fullText.slice(0, 2000);
  }

  return {
    personal: bios.personal.trim(),
    professional: bios.professional.trim(),
    political: bios.political.trim(),
  };
}

function extractIssueSections(_doc: Document, fullText: string): ExtractedProfile['issues'] {
  const issues: ExtractedProfile['issues'] = [];

  // Look for stance patterns: headers followed by bullet points or paragraphs
  const issuePatterns = [
    /(?:^|\n)(Economy|Public Safety|Healthcare|Education|Environment|Immigration|Housing|Transportation|Gun Policy|Abortion|Civil Rights|Criminal Justice|Legal Experience|Consumer Protection)\s*[:\n]/gi
  ];

  for (const pattern of issuePatterns) {
    let match;
    while ((match = pattern.exec(fullText)) !== null) {
      const key = match[1].toLowerCase().replace(/\s+/g, '-');
      const startIdx = match.index + match[0].length;
      const nextSectionIdx = fullText.indexOf('\n\n', startIdx + 50);
      const sectionText = fullText.slice(startIdx, nextSectionIdx > 0 ? nextSectionIdx : startIdx + 500).trim();

      if (sectionText) {
        issues.push({
          key,
          title: match[1],
          stances: [{
            text: sectionText,
            sourceUrl: '',
            quote: '',
          }],
        });
      }
    }
  }

  return issues;
}

function extractSources(doc: Document): Source[] {
  const sources: Source[] = [];
  const seen = new Set<string>();

  // Look for citation patterns in the text
  doc.querySelectorAll('a[href]').forEach(a => {
    const url = (a as HTMLAnchorElement).href;
    if (!url || seen.has(url)) return;

    // Check if this looks like a source citation
    const parent = a.parentElement;
    const context = parent?.textContent ?? '';

    if (context.toLowerCase().includes('source') ||
        context.toLowerCase().includes('quote') ||
        context.toLowerCase().includes('according to') ||
        url.includes('#~text=')) {
      seen.add(url);
      sources.push({
        sourceType: categorizeSourceUrl(url),
        directQuote: '',
        url,
        title: (a as HTMLAnchorElement).textContent?.trim() || undefined,
      });
    }
  });

  return sources;
}

function categorizeSourceUrl(url: string): Source['sourceType'] {
  if (url.includes('facebook.com') || url.includes('twitter.com') || url.includes('instagram.com') || url.includes('tiktok.com')) {
    return 'social';
  }
  if (url.includes('.gov') || url.includes('official')) return 'website';
  // Check for news domains
  if (isNewsDomain(url)) return 'news';
  return 'other';
}

// ── Account Type Inference ─────────────────────────────────

function inferAccountType(url: string, linkText: string): LinkItem['accountType'] {
  const lower = (url + ' ' + linkText).toLowerCase();
  if (lower.includes('/official') || lower.includes('official')) return 'official';
  if (lower.includes('campaign') || lower.includes('elect') || lower.includes('vote') || lower.includes('for')) return 'campaign';
  return 'personal';
}

// ── Paywall Detection ──────────────────────────────────────

/** Known paywall domains — heuristic-only, no HTTP probing */
const PAYWALL_DOMAINS = new Set([
  'nytimes.com', 'wsj.com', 'washingtonpost.com', 'ft.com',
  'economist.com', 'newyorker.com', 'theatlantic.com', 'bostonglobe.com',
  'latimes.com', 'chicagotribune.com', 'sfchronicle.com', 'bloomberg.com',
  'barrons.com', 'thetimes.co.uk', 'telegraph.co.uk', 'haaretz.com',
  'seekingalpha.com', 'theathletic.com', 'businessinsider.com',
  'dallasnews.com', 'houstonchronicle.com', 'denverpost.com',
  'inquirer.com', 'startribune.com', 'seattletimes.com', 'arkansasonline.com',
  'stltoday.com', 'dispatch.com', 'jsonline.com', 'tampabay.com',
]);

function isNewsDomain(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return PAYWALL_DOMAINS.has(host) || host.includes('news') || host.includes('gazette') ||
      host.includes('tribune') || host.includes('herald') || host.includes('journal') ||
      host.includes('times') || host.includes('post') || host.includes('press');
  } catch { return false; }
}

/** Check if a URL is likely behind a paywall */
export function isPaywalled(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return PAYWALL_DOMAINS.has(host);
  } catch {
    return false;
  }
}

// ── Structured Candidate Links Builder ─────────────────────

const ALL_SOCIAL_PLATFORMS: SocialPlatform[] = ['facebook', 'twitter', 'instagram', 'linkedin', 'youtube', 'tiktok'];

/**
 * Build a structured CandidateLinks object from extracted links and sources.
 * Categorizes social media by platform and account type, identifies the
 * candidate website, and tags articles with paywall status.
 */
export function buildCandidateLinks(
  links: LinkItem[],
  sources: Source[],
): CandidateLinks {
  // Find candidate website — prioritize campaign sites
  const websiteLinks = links.filter(l => l.mediaType === 'website');
  const campaignSite = websiteLinks.find(l =>
    l.url.toLowerCase().includes('elect') ||
    l.url.toLowerCase().includes('vote') ||
    l.url.toLowerCase().includes('campaign') ||
    l.url.toLowerCase().includes('for')
  );
  const candidateWebsite = campaignSite ?? websiteLinks[0] ?? null;

  // Social media links
  const socialMedia = links.filter(l =>
    l.mediaType !== 'website' && l.mediaType !== 'other'
  );

  // Articles — news sources with paywall tags
  const articles: Source[] = sources.map(s => ({
    ...s,
    paywalled: isPaywalled(s.url),
    sourceType: categorizeSourceUrl(s.url) as Source['sourceType'],
  }));

  return {
    candidateWebsite,
    socialMedia,
    articles,
    searchedPlatforms: ALL_SOCIAL_PLATFORMS,
  };
}

/**
 * Sanitize HTML for safe rendering in an iframe.
 * Uses DOMPurify to strip all known XSS vectors while preserving layout.
 */
export function sanitizeHtmlForPreview(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: false, mathMl: false },
    // Block dangerous elements
    FORBID_TAGS: [
      'script', 'iframe', 'embed', 'object', 'base',
      'form', 'input', 'button', 'select', 'textarea',
    ],
    // Block dangerous attributes
    FORBID_ATTR: [
      'onerror', 'onload', 'onclick', 'onmouseover', 'onfocus',
      'onblur', 'onsubmit', 'onchange', 'oninput',
      'srcdoc', 'formaction',
    ],
    // Allow safe URI schemes only
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i,
    // Strip data: URIs except for images
    ADD_DATA_URI_TAGS: ['img'],
    WHOLE_DOCUMENT: true,
  });
}
