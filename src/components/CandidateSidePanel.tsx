import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { exportAsBranchJSON, exportAsMarkdown, exportAuditReport } from '../services/exportService';
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

type PanelTab = 'info' | 'draft' | 'log' | 'audit';

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
  const { sessions, setActiveSession, showToast } = useApp();
  const navigate = useNavigate();

  const session: CandidateSession | undefined = useMemo(
    () => item.sessionId ? sessions.find(s => s.id === item.sessionId) : undefined,
    [item.sessionId, sessions],
  );

  const hasSession = Boolean(session);
  const hasDraft = Boolean(session?.currentDraft);
  const hasAudit = Boolean(session?.auditReports?.length);
  const hasLog = Boolean(session?.buildLog?.length);

  // Pick sensible default tab
  const defaultTab: PanelTab = hasDraft ? 'draft' : 'info';
  const [tab, setTab] = useState<PanelTab>(defaultTab);

  // Reset tab when item changes
  useEffect(() => {
    setTab(hasDraft ? 'draft' : 'info');
  }, [item.id, hasDraft]);

  const m = item.metadata;

  /* ─── Actions ────────────────────────────────────── */
  const handleOpenInBuilder = useCallback(() => {
    if (!session) return;
    setActiveSession(session);
    navigate('/build');
  }, [session, setActiveSession, navigate]);

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

  const handleExportAudit = useCallback(() => {
    if (!session?.auditReports?.length) return;
    const latest = session.auditReports[session.auditReports.length - 1];
    downloadFile(
      exportAuditReport(latest),
      `${safeName(session.candidateName)}_audit.txt`,
      'text/plain',
    );
    showToast('Audit report exported', 'success');
  }, [session, showToast]);

  /* ─── Tab definitions ───────────────────────────── */
  const tabs: { id: PanelTab; label: string; enabled: boolean }[] = [
    { id: 'info', label: 'Info', enabled: true },
    { id: 'draft', label: 'Draft', enabled: hasDraft },
    { id: 'log', label: 'Log', enabled: hasLog },
    { id: 'audit', label: 'Audit', enabled: hasAudit },
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
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                item.status === 'complete' ? 'bg-green-100 text-green-700' :
                item.status === 'error' ? 'bg-red-100 text-red-700' :
                'bg-gray-100 text-gray-600'
              }`}>
                {STATUS_LABEL[item.status] || item.status}
              </span>
              {m.party && (
                <span className="text-[10px] text-gray-500">{PARTY_NAMES[m.party] || m.party}</span>
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
          {hasSession && (
            <button className="text-[11px] font-medium text-branch-600 hover:text-branch-700 px-2 py-1 rounded hover:bg-branch-50 transition-colors" onClick={handleOpenInBuilder}>
              Open in Builder
            </button>
          )}
          {hasDraft && (
            <>
              <button className="text-[11px] font-medium text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-100 transition-colors" onClick={handleExportJSON}>
                Export JSON
              </button>
              <button className="text-[11px] font-medium text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-100 transition-colors" onClick={handleExportMD}>
                Export MD
              </button>
            </>
          )}
          {hasAudit && (
            <button className="text-[11px] font-medium text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-100 transition-colors" onClick={handleExportAudit}>
              Export Audit
            </button>
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
          {tab === 'audit' && session && <AuditTab session={session} />}
        </div>
      </div>
    </>
  );
}

/* ═══════════════════════ TAB PANELS ═══════════════════════════════════════ */

/* ─── Info Tab ─────────────────────────────────────── */

function InfoTab({ item, session }: { item: BatchQueueItem; session?: CandidateSession }) {
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
              <dt className="text-[11px] text-gray-400 font-medium">{label}</dt>
              <dd className="text-[11px] text-gray-700">{value}</dd>
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
              <span key={i} className="text-[10px] bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                {issue}
              </span>
            ))}
          </div>
        </Section>
      ) : null}

      {/* Session stats */}
      {session && (
        <Section title="Session">
          <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1.5">
            <dt className="text-[11px] text-gray-400 font-medium">Status</dt>
            <dd className="text-[11px] text-gray-700">{session.status}</dd>
            <dt className="text-[11px] text-gray-400 font-medium">Builder rounds</dt>
            <dd className="text-[11px] text-gray-700">{session.builderRounds.length}</dd>
            <dt className="text-[11px] text-gray-400 font-medium">Audit reports</dt>
            <dd className="text-[11px] text-gray-700">{session.auditReports.length}</dd>
            <dt className="text-[11px] text-gray-400 font-medium">Created</dt>
            <dd className="text-[11px] text-gray-700">{new Date(session.createdAt).toLocaleString()}</dd>
            <dt className="text-[11px] text-gray-400 font-medium">Updated</dt>
            <dd className="text-[11px] text-gray-700">{new Date(session.updatedAt).toLocaleString()}</dd>
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
                <div className="text-[9px] text-gray-400">URLs</div>
              </div>
              <div className="text-center">
                <div className="font-bold text-green-600">{session.provenanceSummary.fromInput}</div>
                <div className="text-[9px] text-gray-400">From Input</div>
              </div>
              <div className="text-center">
                <div className={`font-bold ${session.provenanceSummary.fabricated > 0 ? 'text-red-600' : 'text-green-600'}`}>{session.provenanceSummary.fabricated}</div>
                <div className="text-[9px] text-gray-400">Fabricated</div>
              </div>
            </div>
            {session.provenanceSummary.fabricatedUrls?.length > 0 && (
              <div className="mt-2 border-t border-red-200 pt-1.5 space-y-0.5">
                {session.provenanceSummary.fabricatedUrls.map((url, i) => (
                  <div key={i} className="text-[9px] text-red-600 font-mono truncate">🚩 {url}</div>
                ))}
              </div>
            )}
          </div>
        </Section>
      )}
    </div>
  );
}

/* ─── Draft Tab ────────────────────────────────────── */

function DraftTab({ session }: { session: CandidateSession }) {
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

      {/* Progress bar */}
      {draft.progress !== undefined && (
        <div>
          <div className="flex items-center justify-between text-[10px] text-gray-400 mb-1">
            <span>Profile Completeness</span>
            <span>{Math.round((draft.progress || 0) * 100)}%</span>
          </div>
          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div className="h-full bg-branch-500 rounded-full transition-all" style={{ width: `${(draft.progress || 0) * 100}%` }} />
          </div>
        </div>
      )}

      {/* Bios */}
      {draft.bios?.length ? (
        <Section title="Bios">
          {draft.bios.map((bio, i) => (
            <div key={i} className="mb-3">
              <div className="flex items-center justify-between gap-1.5">
                <span className="text-[9px] font-bold text-gray-400 uppercase">{bio.type}</span>
                {bio.sourceVerified && <SourceBadgeMini status={bio.sourceVerified} />}
              </div>
              <p className="text-[11px] text-gray-700 leading-relaxed whitespace-pre-wrap mt-0.5 max-h-[150px] overflow-y-auto">
                {bio.text || <span className="italic text-gray-300">Empty</span>}
              </p>
              {bio.sources?.length > 0 && (
                <span className="text-[9px] text-gray-400">{bio.sources.length} source{bio.sources.length !== 1 ? 's' : ''}</span>
              )}
            </div>
          ))}
        </Section>
      ) : null}

      {/* Issues / Stances */}
      {draft.issues?.length ? (
        <Section title={`Issues (${draft.issues.length})`}>
          {draft.issues.map((issue, i) => (
            <div key={i} className="mb-3 border-l-2 border-gray-100 pl-2.5">
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] font-semibold text-gray-700">{issue.title}</span>
                {issue.isTopPriority && (
                  <span className="text-[8px] bg-yellow-100 text-yellow-700 px-1 py-0.5 rounded font-bold">PRIORITY</span>
                )}
                {issue.complete && (
                  <span className="text-[8px] text-green-500">✓</span>
                )}
              </div>
              {issue.stances?.length > 0 && (
                <div className="mt-1 space-y-1">
                  {issue.stances.slice(0, 3).map((s, j) => (
                    <div key={j} className="flex items-start gap-1">
                      <p className="text-[10px] text-gray-500 leading-relaxed line-clamp-2 flex-1">{s.text}</p>
                      {s.sourceVerified && <SourceBadgeMini status={s.sourceVerified} />}
                    </div>
                  ))}
                  {issue.stances.length > 3 && (
                    <span className="text-[9px] text-gray-400">+{issue.stances.length - 3} more</span>
                  )}
                </div>
              )}
            </div>
          ))}
        </Section>
      ) : null}

      {/* Links */}
      {draft.links?.length ? (
        <Section title={`Links (${draft.links.length})`}>
          <div className="space-y-1">
            {draft.links.map((link, i) => (
              <div key={i} className="flex items-center gap-1.5 text-[10px]">
                <span className="text-gray-400 shrink-0 capitalize">{link.mediaType}</span>
                <a href={link.url} target="_blank" rel="noreferrer" className="text-branch-600 hover:underline truncate">
                  {link.title || link.url}
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

function LogTab({ session }: { session: CandidateSession }) {
  const log = session.buildLog;
  if (!log?.length) return <p className="text-sm text-gray-400 italic">No build log.</p>;

  return (
    <div className="bg-gray-900 rounded-lg p-3 font-mono text-[11px] leading-relaxed max-h-[calc(100vh-280px)] overflow-y-auto">
      {log.map((line, i) => (
        <div key={i} className={
          line.includes('✅') ? 'text-green-400' :
          line.includes('❌') ? 'text-red-400' :
          line.includes('⚠') ? 'text-yellow-400' :
          'text-gray-300'
        }>{line}</div>
      ))}
    </div>
  );
}

/* ─── Audit Tab ────────────────────────────────────── */

function AuditTab({ session }: { session: CandidateSession }) {
  const reports = session.auditReports;
  if (!reports?.length) return <p className="text-sm text-gray-400 italic">No audit reports.</p>;

  const latest = reports[reports.length - 1];
  const { summary, results } = latest;

  return (
    <div className="space-y-4">
      {/* Summary row */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-green-600 font-bold text-sm">{summary.verified}</span>
          <span className="text-[10px] text-gray-400">verified</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-red-600 font-bold text-sm">{summary.contradicted}</span>
          <span className="text-[10px] text-gray-400">contradicted</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-gray-500 font-bold text-sm">{summary.unverified}</span>
          <span className="text-[10px] text-gray-400">unverified</span>
        </div>
        <div className="ml-auto text-xs text-gray-400">
          Confidence: <span className="font-semibold text-gray-600">{Math.round(summary.overallConfidence * 100)}%</span>
        </div>
      </div>

      {/* Claim list */}
      <div className="space-y-2">
        {results.map((r, i) => (
          <div key={i} className={`rounded-lg border p-3 text-[11px] ${
            r.consensus === 'verified' ? 'border-green-200 bg-green-50/50' :
            r.consensus === 'contradicted' ? 'border-red-200 bg-red-50/50' :
            'border-gray-200 bg-gray-50/50'
          }`}>
            <div className="flex items-start justify-between gap-2">
              <p className="text-gray-800 font-medium flex-1">{r.claim.text}</p>
              <div className="flex items-center gap-1 shrink-0">
                {r.identityMismatch && (
                  <span className="text-[8px] font-bold px-1 py-0.5 rounded bg-red-100 text-red-700">
                    ⚠ Mismatch
                  </span>
                )}
                {r.needsHumanReview && !r.identityMismatch && (
                  <span className="text-[8px] font-bold px-1 py-0.5 rounded bg-yellow-100 text-yellow-700">
                    👀 Review
                  </span>
                )}
                {r.urlValidation && (
                  <span className={`text-[8px] font-bold px-1 py-0.5 rounded ${
                    !r.urlValidation.exists ? 'bg-red-100 text-red-700' :
                    r.urlValidation.quoteFound ? 'bg-green-100 text-green-700' :
                    'bg-yellow-100 text-yellow-700'
                  }`}>
                    {!r.urlValidation.exists ? '🚩 Dead' :
                     r.urlValidation.quoteFound ? '✓ Quote' : '⚠ No Quote'}
                  </span>
                )}
                {r.userOverride === 'flip' && (
                  <span className="text-[8px] font-bold px-1 py-0.5 rounded bg-indigo-100 text-indigo-700">
                    ↔ Human
                  </span>
                )}
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                  r.consensus === 'verified' ? 'bg-green-100 text-green-700' :
                  r.consensus === 'contradicted' ? 'bg-red-100 text-red-700' :
                  'bg-gray-100 text-gray-600'
                }`}>
                  {r.consensus}
                </span>
              </div>
            </div>
            {r.explanation && (
              <p className="text-gray-500 mt-1">{r.explanation}</p>
            )}
            {r.userNote && (
              <p className="text-[10px] text-indigo-700 mt-1 bg-indigo-50 border border-indigo-100 rounded px-2 py-1">Reviewer note: {r.userNote}</p>
            )}
          </div>
        ))}
      </div>

      {reports.length > 1 && (
        <p className="text-[10px] text-gray-400 italic">
          Showing latest report. {reports.length} total audit runs.
        </p>
      )}
    </div>
  );
}

/* ═══════════════════ REUSABLE PANEL PIECES ═══════════════════════════════ */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">{title}</h4>
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
    <span className={`shrink-0 text-[8px] font-bold px-1 py-0.5 rounded whitespace-nowrap ${styles[status] || 'bg-gray-100 text-gray-500'}`}
      title={status}>
      {icons[status] || '·'}
    </span>
  );
}
