import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { exportAsBranchJSON, exportAsMarkdown, exportBuildLog } from '../services/exportService';
import { getCostSummary } from '../services/costTracker';
import { estimateSingleRunCost } from './CostCalculator';
import type { BatchQueueItem, CandidateSession } from '../types';

/* ─── Helpers ──────────────────────────────────────── */

function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function safeName(n: string) {
  return n.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
}

type PanelTab = 'info' | 'draft' | 'log';

const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  importing: 'Importing',
  building: 'Building',
  auditing: 'Auditing',
  complete: 'Complete',
  error: 'Error',
  skipped: 'Skipped',
  paused: 'Paused',
};

const PARTY_NAMES: Record<string, string> = {
  D: 'Democrat', R: 'Republican', I: 'Independent', L: 'Libertarian', G: 'Green',
};

/* ═══════════════════════════════════════════════════════════════════════════ */

interface Props {
  item: BatchQueueItem;
  onClose: () => void;
}

export default function CandidateSidePanel({ item, onClose }: Props) {
  const { sessions, showToast, settings } = useApp();

  const session: CandidateSession | undefined = useMemo(
    () => item.sessionId ? sessions.find(s => s.id === item.sessionId) : undefined,
    [item.sessionId, sessions],
  );

  const hasSession = Boolean(session);
  const hasDraft = Boolean(session?.currentDraft);
  const hasLog = Boolean(session?.buildLog?.length);

  // Pick sensible default tab — show log for actively processing items
  const isActivelyProcessing = ['importing', 'researching', 'building', 'auditing'].includes(item.status);
  const defaultTab: PanelTab = isActivelyProcessing ? 'log' : hasDraft ? 'draft' : hasLog ? 'log' : 'info';
  const [tab, setTab] = useState<PanelTab>(defaultTab);

  // Reset tab when item changes, or switch to log when processing starts
  useEffect(() => {
    if (isActivelyProcessing) {
      setTab('log');
    } else {
      setTab(hasDraft ? 'draft' : hasLog ? 'log' : 'info');
    }
  }, [item.id, hasDraft, hasLog, isActivelyProcessing]);

  const m = item.metadata;

  /* ─── Actions ────────────────────────────────────── */

  const handleExportJSON = useCallback(() => {
    if (!session?.currentDraft) return;
    downloadFile(
      exportAsBranchJSON(session.currentDraft, session.candidateName),
      `${safeName(session.candidateName)}_branch.json`,
      'application/json',
    );
    showToast('Branch JSON exported', 'success');
  }, [session, showToast]);

  const handleExportMD = useCallback(() => {
    if (!session?.currentDraft) return;
    downloadFile(
      exportAsMarkdown(session.currentDraft, session.candidateName),
      `${safeName(session.candidateName)}_profile.md`,
      'text/markdown',
    );
    showToast('Markdown exported', 'success');
  }, [session, showToast]);

  /* ─── Tab definitions ───────────────────────────── */
  const tabs: { id: PanelTab; label: string; enabled: boolean }[] = [
    { id: 'info', label: 'Info', enabled: true },
    { id: 'draft', label: 'Draft', enabled: hasDraft },
    { id: 'log', label: 'Log', enabled: hasLog },
  ];

  /* ═══════════════════ RENDER ═══════════════════════ */
  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 z-40 transition-opacity"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed top-0 right-0 h-full w-[480px] max-w-full bg-white z-50 shadow-2xl flex flex-col animate-slide-in-right">
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <h3 className="text-base font-bold text-gray-900 truncate">{item.candidateName}</h3>
            <div className="flex items-center gap-2 mt-0.5">
              <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                item.status === 'complete' ? 'bg-green-100 text-green-700' :
                item.status === 'error' ? 'bg-red-100 text-red-700' :
                'bg-gray-100 text-gray-600'
              }`}>
                {STATUS_LABEL[item.status] || item.status}
              </span>
              {m.party && (
                <span className="text-xs text-gray-500">{PARTY_NAMES[m.party] || m.party}</span>
              )}
            </div>
          </div>
          <button
            className="text-gray-400 hover:text-gray-600 transition-colors shrink-0 mt-0.5"
            onClick={onClose}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Action bar */}
        <div className="px-5 py-2.5 bg-gray-50/70 border-b border-gray-100 flex items-center gap-2 shrink-0 flex-wrap">
          {hasDraft && (
            <>
              <button className="text-sm font-medium text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-100 transition-colors" onClick={handleExportJSON}>
                Export JSON
              </button>
              <button className="text-sm font-medium text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-100 transition-colors" onClick={handleExportMD}>
                Export MD
              </button>
            </>
          )}
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-100 shrink-0">
          {tabs.map(t => (
            <button
              key={t.id}
              disabled={!t.enabled}
              onClick={() => setTab(t.id)}
              className={`flex-1 text-xs font-semibold py-2.5 transition-colors border-b-2 ${
                tab === t.id
                  ? 'text-branch-600 border-branch-500'
                  : t.enabled
                    ? 'text-gray-400 border-transparent hover:text-gray-600'
                    : 'text-gray-200 border-transparent cursor-not-allowed'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {tab === 'info' && <InfoTab item={item} session={session} />}
          {tab === 'draft' && session && <DraftTab session={session} />}
          {tab === 'log' && session && <LogTab session={session} />}
        </div>
      </div>
    </>
  );
}

/* ═══════════════════════ TAB PANELS ═══════════════════════════════════════ */

/* ─── Info Tab ─────────────────────────────────────── */

function InfoTab({ item, session }: { item: BatchQueueItem; session?: CandidateSession }) {
  const { settings, updateQueueItem } = useApp();
  const [newUrl, setNewUrl] = useState('');
  const m = item.metadata;

  const rows: [string, string | undefined][] = [
    ['Office', m.officeName],
    ['District', m.districtName],
    ['State', m.state],
    ['Party', m.party ? (PARTY_NAMES[m.party] || m.party) : undefined],
    ['Election', m.election],
    ['District Type', m.districtType],
    ['Priority', m.priorityLevel],
    ['Incumbent', m.incumbent !== undefined ? (m.incumbent ? 'Yes' : 'No') : undefined],
  ];

  return (
    <div className="space-y-5">
      {/* Metadata table */}
      <Section title="Metadata">
        <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1.5">
          {rows.filter(([, v]) => v).map(([label, value]) => (
            <React.Fragment key={label}>
              <dt className="text-sm text-gray-400 font-medium">{label}</dt>
              <dd className="text-sm text-gray-700">{value}</dd>
            </React.Fragment>
          ))}
        </dl>
        {rows.every(([, v]) => !v) && (
          <p className="text-xs text-gray-400 italic">No metadata available.</p>
        )}
      </Section>

      {/* Issues to cover */}
      {m.issuesToCover?.length ? (
        <Section title="Issues to Cover">
          <div className="flex flex-wrap gap-1">
            {m.issuesToCover.map((issue, i) => (
              <span key={i} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                {issue}
              </span>
            ))}
          </div>
        </Section>
      ) : null}

      {/* Source URLs — editable when queued */}
      <Section title="Source URLs">
        {item.sourceUrls?.length ? (
          <ul className="space-y-1">
            {item.sourceUrls.map((url, i) => (
              <li key={i} className="flex items-center gap-1.5 group">
                <a href={url} target="_blank" rel="noopener noreferrer"
                  className="text-sm text-branch-600 hover:underline truncate flex-1 font-mono">
                  {url}
                </a>
                {item.status === 'queued' && (
                  <button
                    className="text-xs text-red-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => {
                      const next = item.sourceUrls!.filter((_, j) => j !== i);
                      updateQueueItem(item.id, { sourceUrls: next.length ? next : undefined });
                    }}
                  >×</button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-gray-400 italic">
            {item.status === 'queued' ? 'Add URLs to guide the research phase.' : 'No source URLs provided.'}
          </p>
        )}
        {item.status === 'queued' && (
          <form
            className="flex gap-1.5 mt-2"
            onSubmit={e => {
              e.preventDefault();
              const trimmed = newUrl.trim();
              if (!trimmed) return;
              try { new URL(trimmed); } catch { return; }
              const existing = item.sourceUrls || [];
              if (!existing.includes(trimmed)) {
                updateQueueItem(item.id, { sourceUrls: [...existing, trimmed] });
              }
              setNewUrl('');
            }}
          >
            <input
              type="url"
              className="input text-sm flex-1 font-mono"
              placeholder="https://..."
              value={newUrl}
              onChange={e => setNewUrl(e.target.value)}
            />
            <button type="submit" className="btn-primary text-xs px-2 py-1">Add</button>
          </form>
        )}
      </Section>

      {/* Session stats + cost */}
      {session && (
        <Section title="Session">
          <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1.5">
            <dt className="text-sm text-gray-400 font-medium">Status</dt>
            <dd className="text-sm text-gray-700">{session.status}</dd>
            <dt className="text-sm text-gray-400 font-medium">Builder rounds</dt>
            <dd className="text-sm text-gray-700">{session.builderRounds.length}</dd>

            <dt className="text-sm text-gray-400 font-medium">Created</dt>
            <dd className="text-sm text-gray-700">{new Date(session.createdAt).toLocaleString()}</dd>
            <dt className="text-sm text-gray-400 font-medium">Updated</dt>
            <dd className="text-sm text-gray-700">{new Date(session.updatedAt).toLocaleString()}</dd>
            <SessionCostRows sessionId={session.id} settings={settings} />
          </dl>
        </Section>
      )}

      {/* Error */}
      {item.error && (
        <Section title="Error">
          <p className="text-xs text-red-600 bg-red-50 rounded-lg p-3 font-mono whitespace-pre-wrap">{item.error}</p>
        </Section>
      )}

      {/* Source Integrity */}
      {session?.provenanceSummary && (
        <Section title="Source Integrity">
          <div className={`rounded-lg border p-3 ${
            session.provenanceSummary.fabricated > 0
              ? 'border-red-200 bg-red-50/50'
              : 'border-green-200 bg-green-50/50'
          }`}>
            <div className="flex items-center gap-4 text-xs">
              <div className="text-center">
                <div className="font-bold text-gray-700">{session.provenanceSummary.totalUrls}</div>
                <div className="text-sm text-gray-400">URLs</div>
              </div>
              <div className="text-center">
                <div className="font-bold text-green-600">{session.provenanceSummary.fromInput}</div>
                <div className="text-sm text-gray-400">From Input</div>
              </div>
              <div className="text-center">
                <div className={`font-bold ${session.provenanceSummary.fabricated > 0 ? 'text-red-600' : 'text-green-600'}`}>{session.provenanceSummary.fabricated}</div>
                <div className="text-sm text-gray-400">Fabricated</div>
              </div>
            </div>
            {session.provenanceSummary.fabricatedUrls?.length > 0 && (
              <div className="mt-2 border-t border-red-200 pt-1.5 space-y-0.5">
                {session.provenanceSummary.fabricatedUrls.map((url, i) => (
                  <div key={i} className="text-sm text-red-600 font-mono truncate">🚩 {url}</div>
                ))}
              </div>
            )}
          </div>
        </Section>
      )}
    </div>
  );
}
/* ─── Session cost rows (inside the Session <dl>) ──────────────────────── */
function SessionCostRows({ sessionId, settings }: { sessionId: string; settings: any }) {
  const actualData = getCostSummary().bySession[sessionId];
  const estimate = useMemo(() => {
    try { return estimateSingleRunCost(settings); } catch { return null; }
  }, [settings]);

  const fmt = (n: number) =>
    n === 0 ? 'Free / $0.00' : `$${n.toFixed(4)}`;

  return (
    <>
      <dt className="text-sm text-gray-400 font-medium">Est. cost</dt>
      <dd className="text-sm text-gray-700">
        {estimate ? `${fmt(estimate.expected)} (expected)` : '—'}
      </dd>
      <dt className="text-sm text-gray-400 font-medium">Actual cost</dt>
      <dd className="text-sm text-gray-700">
        {actualData
          ? `${fmt(actualData.costUsd)} · ${actualData.calls} call${actualData.calls !== 1 ? 's' : ''}`
          : 'No API calls recorded'}
      </dd>
    </>
  );
}
/* ─── Confidence Badge ────────────────────────────── */

function ConfidenceBadge({ confidence }: { confidence?: number }) {
  if (confidence == null) return null;
  const pct = Math.round(confidence * 100);
  const color = confidence >= 0.8 ? 'bg-green-100 text-green-700' :
    confidence >= 0.5 ? 'bg-yellow-100 text-yellow-700' :
    'bg-red-100 text-red-700';
  return (
    <span className={`text-xs px-1 py-0.5 rounded font-bold ${color}`}>
      {pct}%
    </span>
  );
}

/* ─── Draft Tab ────────────────────────────────────── */

function DraftTab({ session }: { session: CandidateSession }) {
  const [expandedStances, setExpandedStances] = React.useState<Record<string, boolean>>({});
  const toggleStance = (key: string) => setExpandedStances(prev => ({ ...prev, [key]: !prev[key] }));
  const draft = session.currentDraft;
  if (!draft) return <p className="text-sm text-gray-400 italic">No draft yet.</p>;

  return (
    <div className="space-y-4">
      {/* Overall score if available */}
      {session.builderRounds.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span>Latest critic score:</span>
          <span className="font-bold text-gray-800">
            {session.builderRounds[session.builderRounds.length - 1].criticFeedback.overallScore}/100
          </span>
          <span className="text-gray-300">|</span>
          <span>{session.builderRounds.length} round{session.builderRounds.length !== 1 ? 's' : ''}</span>
        </div>
      )}

      {/* Insufficient-data warning banner */}
      {draft.dataWarning === 'insufficient-sources' && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800">
          <span className="font-semibold">⚠ Limited data:</span> This profile was generated with little or no web research.
          Content may be incomplete or missing. Add source URLs and rebuild for a more complete profile.
        </div>
      )}

      {/* Progress bar */}
      {draft.progress !== undefined && (
        <div>
          <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
            <span>Profile Completeness</span>
            <span>{Math.round((draft.progress || 0) * 100)}%</span>
          </div>
          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div className="h-full bg-branch-500 rounded-full transition-all" style={{ width: `${(draft.progress || 0) * 100}%` }} />
          </div>
        </div>
      )}

      {/* Bios — expandable with source quotes & URLs */}
      {draft.bios?.length ? (
        <Section title="Bios">
          {draft.bios.map((bio, i) => {
            const bioKey = `bio-${i}`;
            const isBioOpen = !!expandedStances[bioKey];
            return (
              <div key={i} className="mb-3">
                <div className="flex items-center justify-between gap-1.5">
                  <span className="text-sm font-bold text-gray-400 uppercase">{bio.type}</span>
                  <span className="flex items-center gap-1">
                    <ConfidenceBadge confidence={bio.confidence} />
                    {bio.sourceVerified && <SourceBadgeMini status={bio.sourceVerified} />}
                  </span>
                </div>
                <p className="text-xs text-gray-700 leading-relaxed whitespace-pre-wrap mt-0.5 max-h-[150px] overflow-y-auto">
                  {bio.text || <span className="italic text-gray-300">Empty</span>}
                </p>
                {bio.sources?.length > 0 && (
                  <button
                    type="button"
                    onClick={() => toggleStance(bioKey)}
                    className="mt-1 flex items-center gap-1 text-xs text-branch-600 hover:underline"
                  >
                    <span className="text-sm">{isBioOpen ? '▼' : '▶'}</span>
                    {bio.sources.length} source{bio.sources.length !== 1 ? 's' : ''}
                  </button>
                )}
                {isBioOpen && bio.sources?.length > 0 && (
                  <div className="mt-1.5 space-y-1.5 pl-2">
                    {bio.sources.map((src, k) => (
                      <div key={k} className="border-l-2 border-branch-200 pl-2">
                        {src.directQuote && (
                          <blockquote className="text-xs text-gray-500 italic leading-snug mb-0.5">
                            &ldquo;{src.directQuote}&rdquo;
                          </blockquote>
                        )}
                        {src.url && (
                          <a href={src.url} target="_blank" rel="noreferrer"
                            className="text-xs text-branch-600 hover:underline break-all">
                            {src.url}
                          </a>
                        )}
                        <div className="flex items-center gap-1 mt-0.5">
                          <ConfidenceBadge confidence={src.confidence} />
                          {src.confidenceReason && (
                            <span className="text-sm text-gray-400">{src.confidenceReason}</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </Section>
      ) : null}

      {/* Issues / Stances — all visible, each clickable → collapsible */}
      {draft.issues?.length ? (
        <Section title={`Issues (${draft.issues.length})`}>
          {draft.issues.map((issue, i) => (
            <div key={i} className="mb-3 border-l-2 border-gray-100 pl-2.5">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-semibold text-gray-700">{issue.title}</span>
                {issue.isTopPriority && (
                  <span className="text-xs bg-yellow-100 text-yellow-700 px-1 py-0.5 rounded font-bold">PRIORITY</span>
                )}
                {issue.complete && (
                  <span className="text-xs text-green-500">✓</span>
                )}
              </div>
              {issue.stances?.length > 0 && (
                <div className="mt-1 space-y-1">
                  {issue.stances.map((s, j) => {
                    const key = `${i}-${j}`;
                    const isOpen = !!expandedStances[key];
                    return (
                      <div key={j} className="rounded border border-transparent hover:border-gray-200 transition-colors">
                        <button
                          type="button"
                          onClick={() => toggleStance(key)}
                          className="w-full flex items-start gap-1 text-left py-0.5 px-1 rounded"
                        >
                          <span className="text-sm text-gray-300 mt-0.5 shrink-0">{isOpen ? '▼' : '▶'}</span>
                          <p className={`text-xs text-gray-500 leading-relaxed flex-1 ${isOpen ? '' : 'line-clamp-2'}`}>{s.text}</p>
                          <span className="shrink-0 flex items-center gap-1">
                            <ConfidenceBadge confidence={s.confidence} />
                            {s.sourceVerified && <SourceBadgeMini status={s.sourceVerified} />}
                          </span>
                        </button>
                        {isOpen && (
                          <div className="pl-4 pr-1 pb-2 space-y-1.5">
                            {s.sources?.length > 0 ? s.sources.map((src, k) => (
                              <div key={k} className="border-l-2 border-branch-200 pl-2">
                                {src.directQuote && (
                                  <blockquote className="text-sm text-gray-500 italic leading-snug border-l-0 pl-0 mb-0.5">
                                    "{src.directQuote}"
                                  </blockquote>
                                )}
                                {src.url && (
                                  <a href={src.url} target="_blank" rel="noreferrer"
                                    className="text-sm text-branch-600 hover:underline break-all">
                                    {src.url}
                                  </a>
                                )}
                                <div className="flex items-center gap-1 mt-0.5">
                                  <ConfidenceBadge confidence={src.confidence} />
                                  {src.confidenceReason && (
                                    <span className="text-xs text-gray-400">{src.confidenceReason}</span>
                                  )}
                                </div>
                              </div>
                            )) : (
                              <span className="text-sm text-gray-400 italic">No sources cited</span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </Section>
      ) : null}

      {/* Articles & Sources — all unique cited URLs */}
      {(() => {
        const allSources = new Map<string, { url: string; quote?: string; title?: string }>();
        for (const bio of draft.bios || []) {
          for (const s of bio.sources || []) {
            if (s.url && !allSources.has(s.url)) allSources.set(s.url, { url: s.url, quote: s.directQuote, title: s.title });
          }
        }
        for (const issue of draft.issues || []) {
          for (const stance of issue.stances || []) {
            for (const s of stance.sources || []) {
              if (s.url && !allSources.has(s.url)) allSources.set(s.url, { url: s.url, quote: s.directQuote, title: s.title });
            }
          }
        }
        const articles = [...allSources.values()];
        if (articles.length === 0) return null;
        return (
          <Section title={`Articles & Sources (${articles.length})`}>
            <div className="space-y-1.5">
              {articles.map((art, i) => {
                let domain = '';
                try { domain = new URL(art.url).hostname.replace('www.', ''); } catch {}
                return (
                  <a key={i} href={art.url} target="_blank" rel="noreferrer"
                    className="flex items-start gap-2 p-1.5 rounded hover:bg-gray-50 transition-colors group">
                    <span className="text-xs text-gray-400 shrink-0 mt-0.5">📄</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-gray-700 group-hover:underline truncate">
                        {art.title || domain || art.url}
                      </div>
                      <div className="text-sm text-gray-400 font-mono truncate">{domain}</div>
                    </div>
                    <span className="text-sm text-gray-300 shrink-0">↗</span>
                  </a>
                );
              })}
            </div>
          </Section>
        );
      })()}

      {/* Links */}
      {draft.links?.length ? (
        <Section title={`Links (${draft.links.length})`}>
          <div className="space-y-2">
            {/* Campaign website featured at top */}
            {(() => {
              const campaign = draft.links.find(l =>
                l.mediaType === 'website' ||
                l.url?.includes('campaign') || l.url?.includes('.com')
              );
              if (!campaign) return null;
              return (
                <a href={campaign.url} target="_blank" rel="noreferrer"
                  className="flex items-center gap-2 p-2 rounded-lg border border-branch-200 bg-branch-50/50 hover:bg-branch-50 transition-colors group">
                  <span className="text-lg">🌐</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-branch-700 group-hover:underline truncate">
                      {campaign.title || campaign.url}
                    </div>
                    <div className="text-sm text-branch-500 font-mono truncate">{campaign.url}</div>
                  </div>
                  <span className="text-sm text-branch-400">↗</span>
                </a>
              );
            })()}
            {/* Social media with platform icons */}
            {draft.links.filter(l => ['twitter', 'facebook', 'instagram', 'youtube', 'linkedin', 'tiktok'].includes(l.mediaType)).length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {draft.links.filter(l => ['twitter', 'facebook', 'instagram', 'youtube', 'linkedin', 'tiktok'].includes(l.mediaType)).map((link, i) => {
                  const icons: Record<string, string> = {
                    twitter: '𝕏', facebook: 'f', instagram: '📷', youtube: '▶',
                    linkedin: 'in', tiktok: '♪',
                  };
                  const colors: Record<string, string> = {
                    twitter: 'bg-gray-900 text-white', facebook: 'bg-blue-600 text-white',
                    instagram: 'bg-gradient-to-br from-purple-600 to-orange-500 text-white',
                    youtube: 'bg-red-600 text-white', linkedin: 'bg-blue-700 text-white',
                    tiktok: 'bg-gray-900 text-white',
                  };
                  return (
                    <a key={i} href={link.url} target="_blank" rel="noreferrer"
                      className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium hover:opacity-80 transition-opacity ${colors[link.mediaType] || 'bg-gray-100 text-gray-600'}`}>
                      <span className="text-xs font-bold">{icons[link.mediaType] || '🔗'}</span>
                      <span className="capitalize">{link.mediaType}</span>
                    </a>
                  );
                })}
              </div>
            )}
            {/* Other links */}
            {draft.links.filter(l => {
              const social = ['twitter', 'facebook', 'instagram', 'youtube', 'linkedin', 'tiktok'];
              const isCampaign = l.mediaType === 'website';
              return !social.includes(l.mediaType) && !isCampaign;
            }).map((link, i) => (
              <div key={i} className="flex items-center gap-1.5 text-xs">
                <span className="text-gray-400 shrink-0 capitalize">{link.mediaType}</span>
                <a href={link.url} target="_blank" rel="noreferrer" className="text-branch-600 hover:underline truncate">
                  {link.title || (() => { try { return new URL(link.url).hostname; } catch { return link.url; } })()}
                </a>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {!draft.bios?.length && !draft.issues?.length && (
        <p className="text-sm text-gray-400 italic">Draft is empty.</p>
      )}
    </div>
  );
}

/* ─── Log Tab ──────────────────────────────────────── */

const URL_RE = /https?:\/\/[^\s)"'<>\]]+/g;

function LogLine({ line }: { line: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(line)) !== null) {
    if (m.index > last) parts.push(line.slice(last, m.index));
    parts.push(
      <a key={m.index} href={m[0]} target="_blank" rel="noreferrer"
        className="underline opacity-80 hover:opacity-100 break-all">
        {m[0]}
      </a>
    );
    last = m.index + m[0].length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return <>{parts}</>;
}

function LogTab({ session }: { session: CandidateSession }) {
  const log = session.buildLog;
  const logEndRef = React.useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new log entries appear
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [log?.length]);

  const handleDownloadLog = useCallback(() => {
    if (!log?.length) return;
    const content = exportBuildLog(log, session.candidateName);
    downloadFile(content, `${safeName(session.candidateName)}_build_log.txt`, 'text/plain');
  }, [log, session.candidateName]);

  if (!log?.length) return (
    <div className="flex flex-col items-center justify-center h-32 text-center">
      <div className="animate-pulse text-gray-400 text-sm">Waiting for log output…</div>
      <div className="text-xs text-gray-300 mt-1">Log will appear here when processing starts</div>
    </div>
  );

  return (
    <div>
      <div className="flex justify-end mb-2">
        <button
          onClick={handleDownloadLog}
          className="inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 rounded px-2.5 py-1 transition-colors"
        >
          <span>⬇</span> Save as TXT
        </button>
      </div>
      <div className="bg-gray-900 rounded-lg p-3 font-mono text-sm leading-relaxed max-h-[calc(100vh-310px)] overflow-y-auto">
      {log.map((line, i) => (
        <div key={i} className={
          line.includes('✅') ? 'text-green-400' :
          line.includes('❌') ? 'text-red-400' :
          line.includes('⚠') ? 'text-yellow-400' :
          line.includes('🌐') || line.includes('📎') ? 'text-sky-400' :
          line.includes('🚩') ? 'text-red-400' :
          line.includes('🔍') || line.includes('🔎') ? 'text-purple-400' :
          'text-gray-300'
        }><LogLine line={line} /></div>
      ))}
      <div ref={logEndRef} />
      </div>
    </div>
  );
}

/* ─── Audit Tab ────────────────────────────────────── */

/* ═══════════════════ REUSABLE PANEL PIECES ═══════════════════════════════ */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5">{title}</h4>
      {children}
    </div>
  );
}

function SourceBadgeMini({ status }: { status: 'verified' | 'unverifiable' | 'fabricated' | 'not-in-input' }) {
  const styles: Record<string, string> = {
    verified: 'bg-green-100 text-green-700',
    unverifiable: 'bg-yellow-100 text-yellow-700',
    fabricated: 'bg-red-100 text-red-700',
    'not-in-input': 'bg-gray-100 text-gray-500',
  };
  const icons: Record<string, string> = {
    verified: '✓', unverifiable: '?', fabricated: '🚩', 'not-in-input': '○',
  };
  return (
    <span className={`shrink-0 text-xs font-bold px-1 py-0.5 rounded whitespace-nowrap ${styles[status] || 'bg-gray-100 text-gray-500'}`}
      title={status}>
      {icons[status] || '·'}
    </span>
  );
}
