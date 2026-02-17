/**
 * Export Service — converts internal data to Branch JSON format and markdown.
 */

import type { StagingDraft, AuditReport } from '../types';

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
      sources: (bio.sources || []).map(s => ({
        sourceType: s.sourceType,
        directQuote: s.directQuote,
        url: s.url,
        title: s.title,
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
        sources: (stance.sources || []).map(s => ({
          sourceType: s.sourceType,
          directQuote: s.directQuote,
          url: s.url,
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
      for (const source of stance.sources || []) {
        lines.push(`  SOURCE URL: ${source.url}`);
        lines.push(`  SUPPORTING QUOTE: "${source.directQuote}"`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Export audit report as markdown.
 */
export function exportAuditReport(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(`# Audit Report: ${report.candidateName}`);
  lines.push(`Generated: ${report.timestamp}`);
  lines.push('');
  lines.push(`## Summary`);
  lines.push(`- Total Claims: ${report.summary.totalClaims}`);
  lines.push(`- Verified: ${report.summary.verified}`);
  lines.push(`- Contradicted: ${report.summary.contradicted}`);
  lines.push(`- Unverified: ${report.summary.unverified}`);
  lines.push(`- Overall Confidence: ${(report.summary.overallConfidence * 100).toFixed(0)}%`);
  lines.push('');
  lines.push('## Claims');
  for (const result of report.results) {
    lines.push(`### ${result.claim.text}`);
    lines.push(`**Consensus:** ${result.consensus} (${(result.confidence * 100).toFixed(0)}%)`);
    lines.push(`**Explanation:** ${result.explanation}`);
    lines.push('');
    for (const vr of result.verifierResults) {
      lines.push(`- [${vr.providerUsed}] ${vr.verdict} (${(vr.confidence * 100).toFixed(0)}%): ${vr.explanation}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
