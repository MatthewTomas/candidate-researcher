/**
 * Export Service — converts internal data to Branch JSON format and markdown.
 */

import type { StagingDraft } from '../types';

/**
 * Export a profile as the Branch stagingDraft JSON format.
 */
export function exportAsBranchJSON(draft: Partial<StagingDraft>, candidateName: string): string {
  const output = {
    name: draft.name || candidateName,
    links: draft.links || [],
    bios: (draft.bios || []).map(bio => ({
      type: bio.type,
      text: bio.text,
      confidence: bio.confidence,
      confidenceReason: bio.confidenceReason,
      sources: (bio.sources || []).map(s => ({
        sourceType: s.sourceType,
        directQuote: s.directQuote,
        url: s.url,
        title: s.title,
        confidence: s.confidence,
        confidenceReason: s.confidenceReason,
      })),
      complete: bio.complete,
      missingData: bio.missingData,
      autoSummary: {
        isAutoSummary: true,
        text: bio.text,
        sources: (bio.sources || []).map(s => ({
          sourceType: s.sourceType,
          directQuote: s.directQuote,
          url: s.url,
        })),
      },
    })),
    issues: (draft.issues || []).map(issue => ({
      key: issue.key,
      title: issue.title,
      complete: issue.complete,
      missingData: issue.missingData,
      stances: (issue.stances || []).map(stance => ({
        text: stance.text,
        confidence: stance.confidence,
        confidenceReason: stance.confidenceReason,
        sources: (stance.sources || []).map(s => ({
          sourceType: s.sourceType,
          directQuote: s.directQuote,
          url: s.url,
          confidence: s.confidence,
          confidenceReason: s.confidenceReason,
        })),
        complete: stance.complete,
        directQuote: stance.directQuote || stance.sources?.[0]?.directQuote || '',
        issuesSecondary: stance.issuesSecondary || [],
        textApproved: false,
        editsMade: false,
        autoSummary: {
          isAutoSummary: true,
          text: stance.text,
          issue: issue.key,
          addedByAutoSummary: true,
          summaryGeneratedBySummarizer: true,
        },
      })),
      textArray: [],
      sources: [],
      isTopPriority: false,
      policyTerms: issue.policyTerms || [],
    })),
    archivedIssues: [],
    progress: calculateProgress(draft),
    status: draft.status || 'incomplete',
    incompleteFields: getIncompleteFields(draft),
    references: buildReferences(draft),
    synced: false,
    version: 1,
    metadata: {
      generatedBy: 'branch-playground',
      generatedAt: new Date().toISOString(),
    },
  };

  return JSON.stringify(output, null, 2);
}

function calculateProgress(draft: Partial<StagingDraft>): number {
  let total = 0;
  let complete = 0;

  // Bios
  for (const bio of draft.bios || []) {
    total++;
    if (bio.complete && bio.text) complete++;
  }

  // Issues
  for (const issue of draft.issues || []) {
    total++;
    if (issue.complete) complete++;
  }

  return total > 0 ? parseFloat((complete / total).toFixed(2)) : 0;
}

function getIncompleteFields(draft: Partial<StagingDraft>): string[] {
  const fields: string[] = [];

  for (const bio of draft.bios || []) {
    if (!bio.complete || !bio.text) fields.push(`Bio: ${bio.type}`);
  }

  for (const issue of draft.issues || []) {
    if (!issue.complete) fields.push(`Issue: ${issue.key}`);
  }

  return fields;
}

function buildReferences(draft: Partial<StagingDraft>): object {
  const allSources = new Map<string, { url: string; mediaType: string; title?: string }>();

  // Collect all unique source URLs
  const collectSources = (sources: Array<{ url: string; sourceType: string; title?: string }>) => {
    for (const s of sources) {
      if (s.url && !allSources.has(s.url)) {
        allSources.set(s.url, {
          url: s.url,
          mediaType: s.sourceType === 'website' ? 'website' : 'other',
          title: s.title,
        });
      }
    }
  };

  for (const bio of draft.bios || []) {
    collectSources(bio.sources || []);
  }
  for (const issue of draft.issues || []) {
    for (const stance of issue.stances || []) {
      collectSources(stance.sources || []);
    }
  }

  // Categorize
  const categories = {
    website: [] as object[],
    social: [] as object[],
    news: [] as object[],
    other: [] as object[],
  };

  for (const [, source] of allSources) {
    const url = source.url.toLowerCase();
    if (url.includes('facebook.com') || url.includes('twitter.com') || url.includes('instagram.com')) {
      categories.social.push(source);
    } else if (url.includes('.gov') || url.includes('official')) {
      categories.website.push(source);
    } else if (url.includes('news') || url.includes('report') || url.includes('ksat') || url.includes('express')) {
      categories.news.push(source);
    } else {
      categories.other.push(source);
    }
  }

  return {
    checked: true,
    totalSources: allSources.size,
    categories: Object.entries(categories).map(([type, sources]) => ({
      type,
      sources,
      missing: sources.length === 0,
    })),
  };
}

/**
 * Export profile as human-readable markdown following the template format.
 */
export function exportAsMarkdown(draft: Partial<StagingDraft>, candidateName: string): string {
  const lines: string[] = [];
  lines.push(`# ${draft.name || candidateName}`);
  lines.push('');

  // Links
  if (draft.links?.length) {
    lines.push('## Links');
    for (const link of draft.links) {
      lines.push(`- [${link.title || link.mediaType}](${link.url})`);
    }
    lines.push('');
  }

  // Bios
  for (const bio of draft.bios || []) {
    const title = bio.type.charAt(0).toUpperCase() + bio.type.slice(1);
    lines.push(`## ${title} Background`);
    lines.push(bio.text || '_No information available._');
    lines.push('');
    for (const source of bio.sources || []) {
      lines.push(`SOURCE URL: ${source.url}`);
      lines.push(`SUPPORTING QUOTE: "${source.directQuote}"`);
      if (source.confidence != null && source.confidence < 0.8) {
        lines.push(`CONFIDENCE: ${Math.round(source.confidence * 100)}% — ${source.confidenceReason || 'unverified'}`);
      }
      lines.push('');
    }
    if (bio.confidence != null && bio.confidence < 0.8) {
      lines.push(`> ⚠ Bio confidence: ${Math.round(bio.confidence * 100)}%${bio.confidenceReason ? ' — ' + bio.confidenceReason : ''}`);
      lines.push('');
    }
  }

  // Issues
  for (const issue of draft.issues || []) {
    lines.push(`## ${issue.title}`);
    if (issue.text) {
      lines.push(issue.text);
    }
    for (const stance of issue.stances || []) {
      lines.push(`- ${stance.text}`);
      if (stance.confidence != null && stance.confidence < 0.8) {
        lines.push(`  CONFIDENCE: ${Math.round(stance.confidence * 100)}%${stance.confidenceReason ? ' — ' + stance.confidenceReason : ''}`);
      }
      for (const source of stance.sources || []) {
        lines.push(`  SOURCE URL: ${source.url}`);
        lines.push(`  SUPPORTING QUOTE: "${source.directQuote}"`);
        if (source.confidence != null && source.confidence < 0.8) {
          lines.push(`  CONFIDENCE: ${Math.round(source.confidence * 100)}% — ${source.confidenceReason || 'unverified'}`);
        }
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Export build log as plain text.
 */
export function exportBuildLog(log: string[], candidateName: string): string {
  const header = `Build Log: ${candidateName}\nExported: ${new Date().toLocaleString()}\n${'─'.repeat(60)}\n`;
  return header + log.join('\n');
}
