/**
 * SourcePopup — modal popup showing a source's full direct quote
 * with a link to the source page using text-fragment highlighting.
 *
 * Text fragments (#:~:text=...) work in Chrome, Edge, and Opera (80%+ share).
 * Graceful fallback: source URL without fragment in unsupported browsers.
 */

import React, { useEffect, useRef, useCallback } from 'react';
import type { Source } from '../types';

interface SourcePopupProps {
  source: Source;
  onClose: () => void;
}

const SOURCE_TYPE_LABELS: Record<string, string> = {
  website: 'Website',
  news: 'News',
  social: 'Social Media',
  questionnaire: 'Questionnaire',
  other: 'Other',
};

/**
 * Build a text-fragment URL.
 * If the quote is short (<=300 chars), use direct text.
 * If long, use prefix,suffix fragment (first 80 chars + last 80 chars).
 */
function buildTextFragmentUrl(baseUrl: string, quote: string): string {
  if (!quote || !quote.trim()) return baseUrl;

  // Sanitize: strip newlines, collapse whitespace
  const clean = quote.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

  if (clean.length <= 300) {
    return `${baseUrl}#:~:text=${encodeURIComponent(clean)}`;
  }

  // Long quote: use start,end fragment
  const start = clean.slice(0, 80).trim();
  const end = clean.slice(-80).trim();
  return `${baseUrl}#:~:text=${encodeURIComponent(start)},${encodeURIComponent(end)}`;
}

export default function SourcePopup({ source, onClose }: SourcePopupProps) {
  const backdropRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Close on backdrop click
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose();
  }, [onClose]);

  const handleCopyQuote = useCallback(async () => {
    if (source.directQuote) {
      await navigator.clipboard.writeText(source.directQuote);
    }
  }, [source.directQuote]);

  const fragmentUrl = buildTextFragmentUrl(source.url, source.directQuote);
  const hasQuote = source.directQuote && source.directQuote.trim().length > 0;

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onClick={handleBackdropClick}
    >
      <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="px-5 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-800">Source</span>
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${
              source.sourceType === 'website' ? 'bg-blue-50 text-blue-600 border-blue-200' :
              source.sourceType === 'news' ? 'bg-purple-50 text-purple-600 border-purple-200' :
              source.sourceType === 'social' ? 'bg-pink-50 text-pink-600 border-pink-200' :
              'bg-gray-50 text-gray-600 border-gray-200'
            }`}>
              {SOURCE_TYPE_LABELS[source.sourceType] || source.sourceType}
            </span>
          </div>
          <button
            className="text-gray-400 hover:text-gray-600 transition-colors"
            onClick={onClose}
            aria-label="Close source popup"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {/* URL */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold mb-1">Source URL</div>
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-branch-600 hover:text-branch-700 hover:underline break-all"
            >
              {source.url}
            </a>
          </div>

          {/* Title */}
          {source.title && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold mb-1">Title</div>
              <p className="text-sm text-gray-700">{source.title}</p>
            </div>
          )}

          {/* Direct Quote */}
          {hasQuote && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold mb-1">
                Supporting Quote
              </div>
              <blockquote className="border-l-3 border-branch-300 bg-branch-50/50 rounded-r-lg px-4 py-3 text-sm text-gray-700 leading-relaxed italic">
                &ldquo;{source.directQuote}&rdquo;
              </blockquote>
              <p className="text-[10px] text-gray-400 mt-1.5">
                This quote should be searchable with CMD+F / Ctrl+F on the source page.
              </p>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="px-5 py-3 bg-gray-50 border-t border-gray-200 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {hasQuote && (
              <button
                className="text-xs text-gray-500 hover:text-gray-700 font-medium flex items-center gap-1 transition-colors"
                onClick={handleCopyQuote}
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                Copy Quote
              </button>
            )}
          </div>
          <a
            href={fragmentUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-primary text-xs px-4 py-1.5 flex items-center gap-1.5"
          >
            Open Source
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        </div>
      </div>
    </div>
  );
}
