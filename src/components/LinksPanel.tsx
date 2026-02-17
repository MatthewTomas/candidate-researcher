/**
 * LinksPanel — structured display of candidate social media links,
 * website, and article sources with paywall indicators.
 *
 * Shows a grid of social platforms × account types with checkmarks/dashes,
 * the candidate website prominently at top, and articles with paywall badges.
 */

import React from 'react';
import type { CandidateLinks, LinkItem, Source, SocialPlatform } from '../types';

const PLATFORM_LABELS: Record<SocialPlatform, { label: string; icon: string }> = {
  facebook:  { label: 'Facebook',  icon: '📘' },
  twitter:   { label: 'X / Twitter', icon: '𝕏' },
  instagram: { label: 'Instagram', icon: '📸' },
  linkedin:  { label: 'LinkedIn',  icon: '💼' },
  youtube:   { label: 'YouTube',   icon: '▶️' },
  tiktok:    { label: 'TikTok',    icon: '🎵' },
};

const ACCOUNT_TYPES = ['official', 'campaign', 'personal'] as const;
const ACCOUNT_LABELS: Record<string, string> = {
  official: 'Official',
  campaign: 'Campaign',
  personal: 'Personal',
};

const CONFIDENCE_COLORS: Record<string, string> = {
  high:   'bg-green-100 text-green-700 border-green-200',
  medium: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  low:    'bg-gray-100 text-gray-500 border-gray-200',
};

interface LinksPanelProps {
  links: CandidateLinks;
  compact?: boolean;
}

export default function LinksPanel({ links, compact = false }: LinksPanelProps) {
  const { candidateWebsite, socialMedia, articles, searchedPlatforms } = links;

  // Group social links by platform and account type
  const socialGrid = new Map<SocialPlatform, Map<string, LinkItem>>();
  for (const platform of searchedPlatforms) {
    socialGrid.set(platform, new Map());
  }
  for (const link of socialMedia) {
    const platform = link.mediaType as SocialPlatform;
    if (socialGrid.has(platform)) {
      const acctType = link.accountType || 'personal';
      socialGrid.get(platform)!.set(acctType, link);
    }
  }

  return (
    <div className={`space-y-${compact ? '3' : '4'}`}>
      {/* ── Candidate Website ── */}
      <div className={`rounded-lg border ${candidateWebsite ? 'border-branch-200 bg-branch-50' : 'border-gray-200 bg-gray-50'} p-3`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-lg">🌐</span>
            <div>
              <div className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Candidate Website</div>
              {candidateWebsite ? (
                <a
                  href={candidateWebsite.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-branch-600 hover:text-branch-800 font-medium hover:underline break-all"
                >
                  {candidateWebsite.title || candidateWebsite.url}
                </a>
              ) : (
                <span className="text-xs text-gray-400 italic">Not found</span>
              )}
            </div>
          </div>
          {candidateWebsite ? (
            <span className="text-green-600 text-lg">✓</span>
          ) : (
            <span className="text-gray-300 text-sm">—</span>
          )}
        </div>
      </div>

      {/* ── Social Media Grid ── */}
      <div className="rounded-lg border border-gray-200 overflow-hidden">
        <div className="bg-gray-50 px-3 py-2 border-b border-gray-200">
          <span className="text-xs font-semibold text-gray-600 uppercase tracking-wider">Social Media</span>
        </div>

        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50/50">
              <th className="text-left px-3 py-1.5 font-medium text-gray-500">Platform</th>
              {ACCOUNT_TYPES.map(t => (
                <th key={t} className="text-center px-2 py-1.5 font-medium text-gray-500 w-24">
                  {ACCOUNT_LABELS[t]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {searchedPlatforms.map(platform => {
              const platformLinks = socialGrid.get(platform);
              const info = PLATFORM_LABELS[platform];
              return (
                <tr key={platform} className="border-b border-gray-50 hover:bg-gray-50/30">
                  <td className="px-3 py-2 text-gray-700 font-medium">
                    <span className="mr-1.5">{info.icon}</span>
                    {info.label}
                  </td>
                  {ACCOUNT_TYPES.map(acctType => {
                    const link = platformLinks?.get(acctType);
                    return (
                      <td key={acctType} className="text-center px-2 py-2">
                        {link ? (
                          <a
                            href={link.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 group"
                            title={link.url}
                          >
                            <span className="text-green-600 group-hover:text-green-700">✓</span>
                            {link.confidence && (
                              <span className={`text-[9px] px-1 rounded border ${CONFIDENCE_COLORS[link.confidence]}`}>
                                {link.confidence.charAt(0).toUpperCase()}
                              </span>
                            )}
                          </a>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── Articles / Sources ── */}
      {articles.length > 0 && (
        <div className="rounded-lg border border-gray-200 overflow-hidden">
          <div className="bg-gray-50 px-3 py-2 border-b border-gray-200 flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-600 uppercase tracking-wider">
              Articles & Sources
            </span>
            <span className="text-[10px] text-gray-400">{articles.length} found</span>
          </div>
          <div className="divide-y divide-gray-50 max-h-60 overflow-y-auto">
            {articles.map((article, i) => (
              <ArticleRow key={i} source={article} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ArticleRow({ source }: { source: Source }) {
  const domain = (() => {
    try { return new URL(source.url).hostname.replace(/^www\./, ''); }
    catch { return source.url; }
  })();

  return (
    <div className="px-3 py-2 flex items-center gap-2 text-xs hover:bg-gray-50/50">
      <span className="text-gray-400 flex-shrink-0">📄</span>
      <a
        href={source.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-branch-600 hover:text-branch-800 hover:underline truncate flex-1 font-medium"
        title={source.url}
      >
        {source.title || domain}
      </a>
      <span className="text-[10px] text-gray-400 flex-shrink-0">{domain}</span>
      {source.paywalled && (
        <span className="inline-flex items-center gap-0.5 text-[9px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 flex-shrink-0">
          🔒 Paywall
        </span>
      )}
      {source.sourceType && (
        <span className={`text-[9px] px-1.5 py-0.5 rounded border flex-shrink-0 ${
          source.sourceType === 'social' ? 'bg-blue-50 text-blue-600 border-blue-200' :
          source.sourceType === 'news' ? 'bg-purple-50 text-purple-600 border-purple-200' :
          source.sourceType === 'website' ? 'bg-green-50 text-green-600 border-green-200' :
          'bg-gray-50 text-gray-500 border-gray-200'
        }`}>
          {source.sourceType}
        </span>
      )}
    </div>
  );
}
