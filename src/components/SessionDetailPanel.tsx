import React, { useState, useCallback, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { exportAsBranchJSON, exportAsMarkdown } from '../services/exportService';
import type { CandidateSession } from '../types';

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

type PanelTab = 'profile' | 'rounds' | 'log' | 'export';

const STATUS_COLORS: Record<string, string> = {
  importing: 'bg-blue-100 text-blue-700',
  building: 'bg-yellow-100 text-yellow-700',
  complete: 'bg-green-100 text-green-700',
};

/* ═══════════════════════════════════════════════════════════════════════════ */

interface Props {
  session: CandidateSession;
  onClose: () => void;
  onExportJSON: () => void;
  onExportMD: () => void;
}

export default function SessionDetailPanel({ session, onClose, onExportJSON, onExportMD }: Props) {
  const draft = session.currentDraft;
  const hasDraft = Boolean(draft);
  const hasLog = Boolean(session.buildLog?.length);
  const hasRounds = session.builderRounds.length > 0;

  const defaultTab: PanelTab = hasDraft ? 'profile' : hasLog ? 'log' : 'export';
  const [tab, setTab] = useState<PanelTab>(defaultTab);

  useEffect(() => {
    setTab(hasDraft ? 'profile' : hasLog ? 'log' : 'export');
  }, [session.id]);

  const tabs: { id: PanelTab; label: string; icon: string; enabled: boolean }[] = [
    { id: 'profile', label: 'Profile', icon: '📄', enabled: hasDraft },
    { id: 'rounds', label: 'Rounds', icon: '🔄', enabled: hasRounds },
    { id: 'log', label: 'Log', icon: '📋', enabled: hasLog },
    { id: 'export', label: 'Export', icon: '📦', enabled: true },
  ];

  const latestScore = hasRounds
    ? session.builderRounds[session.builderRounds.length - 1].criticFeedback.overallScore
    : null;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />

      {/* Panel — wider for history detail */}
      <div className="fixed top-0 right-0 h-full w-[640px] max-w-[85vw] bg-white z-50 shadow-2xl flex flex-col animate-slide-in-right">
        {/* ─── Header ─────────────────────────────────── */}
        <div className="px-6 py-5 border-b border-gray-100 shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-bold text-gray-900 truncate">{session.candidateName}</h2>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${STATUS_COLORS[session.status] || 'bg-gray-100 text-gray-600'}`}>
                  {session.status}
                </span>
                {session.metadata?.officeName && (
                  <span className="text-sm text-gray-500">{session.metadata.officeName}</span>
                )}
                {session.metadata?.state && (
                  <span className="text-sm text-gray-400">· {session.metadata.state}</span>
                )}
              </div>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors mt-1">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Quick stats */}
          <div className="flex items-center gap-4 mt-3">
            {latestScore !== null && (
              <div className="flex items-center gap-1.5">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                  latestScore >= 80 ? 'bg-green-100 text-green-700' :
                  latestScore >= 60 ? 'bg-yellow-100 text-yellow-700' :
                  'bg-red-100 text-red-700'
                }`}>{latestScore}</div>
                <span className="text-xs text-gray-400">Score</span>
              </div>
            )}
            <div className="text-sm text-gray-500">
              <span className="font-semibold text-gray-700">{session.builderRounds.length}</span> rounds
            </div>
            {session.provenanceSummary && session.provenanceSummary.fabricated > 0 && (
              <div className="flex items-center gap-1 text-sm">
                <span className="text-red-600 font-semibold">⚠ {session.provenanceSummary.fabricated}</span>
                <span className="text-xs text-red-400">fabricated</span>
              </div>
            )}
            <div className="ml-auto text-xs text-gray-400">
              {new Date(session.updatedAt).toLocaleString()}
            </div>
          </div>
        </div>

        {/* ─── Tab bar ────────────────────────────────── */}
        <div className="flex border-b border-gray-100 shrink-0 px-2">
          {tabs.map(t => (
            <button
              key={t.id}
              disabled={!t.enabled}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1 px-3 py-2.5 text-xs font-semibold transition-colors border-b-2 ${
                tab === t.id
                  ? 'text-branch-600 border-branch-500'
                  : t.enabled
                    ? 'text-gray-400 border-transparent hover:text-gray-600'
                    : 'text-gray-200 border-transparent cursor-not-allowed'
              }`}
            >
              <span className="text-sm">{t.icon}</span> {t.label}
            </button>
          ))}
        </div>

        {/* ─── Content ────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto">
          {tab === 'profile' && <ProfileTab session={session} />}
          {tab === 'rounds' && <RoundsTab session={session} />}
          {tab === 'log' && <LogTab session={session} />}
          {tab === 'export' && <ExportTab session={session} onExportJSON={onExportJSON} onExportMD={onExportMD} />}
        </div>
      </div>
    </>
  );
}

/* ═══════════════════════ TAB: Profile ═══════════════════════════════════ */

function ProfileTab({ session }: { session: CandidateSession }) {
  const draft = session.currentDraft;
  if (!draft) return <Empty text="No profile draft yet." />;

  return (
    <div className="p-6 space-y-6">
      {/* Progress */}
      {draft.progress !== undefined && (
        <div>
          <div className="flex items-center justify-between text-xs text-gray-500 mb-1.5">
            <span className="font-medium">Profile Completeness</span>
            <span className="font-bold text-gray-700">{Math.round((draft.progress || 0) * 100)}%</span>
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                (draft.progress || 0) >= 0.8 ? 'bg-green-500' :
                (draft.progress || 0) >= 0.5 ? 'bg-yellow-500' : 'bg-orange-500'
              }`}
              style={{ width: `${(draft.progress || 0) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Bios */}
      {draft.bios?.map((bio, i) => (
        <Section key={i} title={`${bio.type.charAt(0).toUpperCase() + bio.type.slice(1)} Bio`} color="border-blue-200 bg-blue-50/30">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap flex-1">{bio.text || <span className="italic text-gray-300">Empty</span>}</p>
            {bio.sourceVerified && <SourceBadge status={bio.sourceVerified} />}
          </div>
          {bio.sources?.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {bio.sources.map((src, j) => (
                <a key={j} href={src.url} target="_blank" rel="noreferrer" className="text-xs text-branch-600 bg-branch-50 px-1.5 py-0.5 rounded hover:underline truncate max-w-[200px]">
                  {src.title || src.url}
                </a>
              ))}
            </div>
          )}
        </Section>
      ))}

      {/* Issues / Stances */}
      {draft.issues?.length ? (
        <div className="space-y-3">
          <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider">Issues & Stances ({draft.issues.length})</h3>
          {draft.issues.map((issue, i) => (
            <Section key={i} title={issue.title} color={issue.isTopPriority ? 'border-yellow-300 bg-yellow-50/30' : 'border-gray-200 bg-gray-50/30'}>
              <div className="flex items-center gap-2 mb-2">
                {issue.isTopPriority && (
                  <span className="text-sm font-bold bg-yellow-200 text-yellow-800 px-1.5 py-0.5 rounded">PRIORITY</span>
                )}
                {issue.complete ? (
                  <span className="text-sm font-bold bg-green-100 text-green-700 px-1.5 py-0.5 rounded">COMPLETE</span>
                ) : (
                  <span className="text-sm font-bold bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded">INCOMPLETE</span>
                )}
                {issue.policyTerms?.length > 0 && (
                  <div className="flex gap-0.5">
                    {issue.policyTerms.slice(0, 3).map((t, j) => (
                      <span key={j} className="text-sm bg-gray-100 text-gray-500 px-1 py-0.5 rounded">{t}</span>
                    ))}
                  </div>
                )}
              </div>
              {issue.stances?.map((stance, j) => (
                <div key={j} className="mb-2 last:mb-0">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm text-gray-700 leading-relaxed flex-1">{stance.text}</p>
                    {stance.sourceVerified && <SourceBadge status={stance.sourceVerified} />}
                  </div>
                  {stance.directQuote && (
                    <blockquote className="mt-1 pl-3 border-l-2 border-gray-200 text-xs text-gray-500 italic">
                      "{stance.directQuote}"
                    </blockquote>
                  )}
                  {stance.sources?.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {stance.sources.map((src, k) => (
                        <a key={k} href={src.url} target="_blank" rel="noreferrer" className="text-xs text-branch-600 bg-branch-50 px-1.5 py-0.5 rounded hover:underline truncate max-w-[200px]">
                          {src.title || src.url}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {(!issue.stances || issue.stances.length === 0) && issue.text && (
                <p className="text-sm text-gray-700 leading-relaxed">{issue.text}</p>
              )}
            </Section>
          ))}
        </div>
      ) : null}

      {/* Links */}
      {draft.links?.length ? (
        <Section title={`Links (${draft.links.length})`} color="border-gray-200 bg-gray-50/30">
          <div className="space-y-1.5">
            {draft.links.map((link, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <span className="text-xs text-gray-400 font-medium capitalize w-16 shrink-0">{link.mediaType}</span>
                <a href={link.url} target="_blank" rel="noreferrer" className="text-branch-600 hover:underline truncate">
                  {link.title || link.url}
                </a>
                {link.confidence && (
                  <span className={`text-sm font-bold px-1 py-0.5 rounded ${
                    link.confidence === 'high' ? 'bg-green-100 text-green-700' :
                    link.confidence === 'medium' ? 'bg-yellow-100 text-yellow-700' :
                    'bg-red-100 text-red-700'
                  }`}>{link.confidence}</span>
                )}
              </div>
            ))}
          </div>
        </Section>
      ) : null}
    </div>
  );
}

/* ═══════════════════════ TAB: Rounds ════════════════════════════════════ */

function RoundsTab({ session }: { session: CandidateSession }) {
  const rounds = session.builderRounds;
  if (!rounds.length) return <Empty text="No build rounds yet." />;

  const [expanded, setExpanded] = useState<number | null>(rounds.length - 1);

  return (
    <div className="p-6 space-y-3">
      <p className="text-xs text-gray-500">{rounds.length} writer/critic round{rounds.length !== 1 ? 's' : ''}</p>
      {rounds.map((round, i) => {
        const fb = round.criticFeedback;
        const isOpen = expanded === i;
        const criticalCount = fb.issues.filter(iss => iss.severity === 'critical').length;
        const majorCount = fb.issues.filter(iss => iss.severity === 'major').length;

        return (
          <div key={i} className="border border-gray-200 rounded-lg overflow-hidden">
            <button
              className="w-full px-4 py-3 flex items-center justify-between bg-gray-50/50 hover:bg-gray-100/50 transition-colors"
              onClick={() => setExpanded(isOpen ? null : i)}
            >
              <div className="flex items-center gap-3">
                <span className="text-xs font-bold text-gray-500">Round {round.roundNumber}</span>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                  fb.overallScore >= 80 ? 'bg-green-100 text-green-700' :
                  fb.overallScore >= 60 ? 'bg-yellow-100 text-yellow-700' :
                  'bg-red-100 text-red-700'
                }`}>{fb.overallScore}</div>
                {criticalCount > 0 && <span className="text-xs font-bold bg-red-100 text-red-700 px-1.5 py-0.5 rounded">{criticalCount} critical</span>}
                {majorCount > 0 && <span className="text-xs font-bold bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded">{majorCount} major</span>}
              </div>
              <svg className={`h-4 w-4 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {isOpen && (
              <div className="px-4 py-4 border-t border-gray-100 space-y-3">
                <p className="text-sm text-gray-700">{fb.overallAssessment}</p>
                {fb.issues.length > 0 && (
                  <div className="space-y-2">
                    <span className="text-xs font-bold text-gray-400 uppercase">Issues ({fb.issues.length})</span>
                    {fb.issues.map((iss, j) => (
                      <div key={j} className={`rounded-lg border p-2.5 text-xs ${
                        iss.severity === 'critical' ? 'border-red-200 bg-red-50/50' :
                        iss.severity === 'major' ? 'border-orange-200 bg-orange-50/50' :
                        iss.severity === 'minor' ? 'border-yellow-200 bg-yellow-50/50' :
                        'border-gray-200 bg-gray-50/50'
                      }`}>
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`text-sm font-bold px-1.5 py-0.5 rounded uppercase ${
                            iss.severity === 'critical' ? 'bg-red-100 text-red-700' :
                            iss.severity === 'major' ? 'bg-orange-100 text-orange-700' :
                            iss.severity === 'minor' ? 'bg-yellow-100 text-yellow-700' :
                            'bg-blue-100 text-blue-600'
                          }`}>{iss.severity}</span>
                          <span className="text-xs text-gray-400">{iss.category}</span>
                          <span className="text-xs text-gray-300">§{iss.section}</span>
                          {iss.resolved && <span className="text-xs text-green-600 font-medium">✓ Resolved</span>}
                        </div>
                        <p className="text-gray-700">{iss.description}</p>
                        {iss.suggestion && <p className="text-gray-500 mt-1 italic">→ {iss.suggestion}</p>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════════ TAB: Audit ════════════════════════════════════ */

/* ═══════════════════════ TAB: Log ══════════════════════════════════════ */

function LogTab({ session }: { session: CandidateSession }) {
  const log = session.buildLog;
  if (!log?.length) return <Empty text="No build log." />;

  const handleDownloadLog = () => {
    const header = `Build Log: ${session.candidateName}\nExported: ${new Date().toLocaleString()}\n${'─'.repeat(60)}\n`;
    const content = header + log.join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${session.candidateName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '')}_build_log.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-4">
      <div className="flex justify-end mb-2">
        <button
          onClick={handleDownloadLog}
          className="inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-700 bg-gray-100 hover:bg-gray-200 rounded px-2.5 py-1 transition-colors"
        >
          <span>⬇</span> Save as TXT
        </button>
      </div>
      <div className="bg-gray-900 rounded-lg p-4 font-mono text-xs leading-relaxed max-h-[calc(100vh-260px)] overflow-y-auto">
        {log.map((line, i) => (
          <div key={i} className={
            line.includes('✅') ? 'text-green-400' :
            line.includes('❌') ? 'text-red-400' :
            line.includes('⚠') ? 'text-yellow-400' :
            'text-gray-300'
          }>{line}</div>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════ TAB: Export ═══════════════════════════════════ */

function ExportTab({ session, onExportJSON, onExportMD }: {
  session: CandidateSession;
  onExportJSON: () => void;
  onExportMD: () => void;
}) {
  const hasDraft = Boolean(session.currentDraft);

  return (
    <div className="p-6 space-y-4">
      <p className="text-sm text-gray-500">Download this candidate's data in various formats.</p>

      <div className="space-y-3">
        <ExportButton
          title="Branch JSON"
          description="Full structured profile matching the Branch API format. Use for importing into Branch."
          icon="{ }"
          iconColor="bg-blue-100 text-blue-700"
          enabled={hasDraft}
          onClick={onExportJSON}
        />
        <ExportButton
          title="Markdown"
          description="Human-readable profile document. Good for review and sharing."
          icon="MD"
          iconColor="bg-purple-100 text-purple-700"
          enabled={hasDraft}
          onClick={onExportMD}
        />
      </div>

      {/* Session metadata */}
      <div className="border-t border-gray-100 pt-4 mt-4">
        <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Session Info</h4>
        <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1.5 text-xs">
          <dt className="text-gray-400">Created</dt>
          <dd className="text-gray-700">{new Date(session.createdAt).toLocaleString()}</dd>
          <dt className="text-gray-400">Updated</dt>
          <dd className="text-gray-700">{new Date(session.updatedAt).toLocaleString()}</dd>
          <dt className="text-gray-400">Status</dt>
          <dd className="text-gray-700">{session.status}</dd>
          <dt className="text-gray-400">Rounds</dt>
          <dd className="text-gray-700">{session.builderRounds.length}</dd>
          {session.metadata?.election && <>
            <dt className="text-gray-400">Election</dt>
            <dd className="text-gray-700">{session.metadata.election}</dd>
          </>}
          {session.metadata?.party && <>
            <dt className="text-gray-400">Party</dt>
            <dd className="text-gray-700">{session.metadata.party}</dd>
          </>}
        </dl>
      </div>
    </div>
  );
}

/* ═══════════════════ REUSABLE PIECES ═══════════════════════════════════ */

function Section({ title, color, children }: { title: string; color: string; children: React.ReactNode }) {
  return (
    <div className={`rounded-lg border-l-4 p-4 ${color}`}>
      <h4 className="text-xs font-bold text-gray-700 mb-2">{title}</h4>
      {children}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className={`rounded-lg border p-3 text-center ${color}`}>
      <div className="text-xl font-bold">{value}</div>
      <div className="text-xs text-gray-500 mt-0.5">{label}</div>
    </div>
  );
}

function ExportButton({ title, description, icon, iconColor, enabled, onClick }: {
  title: string; description: string; icon: string; iconColor: string; enabled: boolean; onClick: () => void;
}) {
  return (
    <button
      className={`w-full flex items-center gap-4 p-4 rounded-lg border text-left transition-colors ${
        enabled ? 'border-gray-200 hover:border-branch-300 hover:bg-branch-50/30' : 'border-gray-100 opacity-50 cursor-not-allowed'
      }`}
      disabled={!enabled}
      onClick={onClick}
    >
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-sm font-bold ${iconColor}`}>
        {icon}
      </div>
      <div>
        <div className="text-sm font-semibold text-gray-800">{title}</div>
        <div className="text-sm text-gray-500">{description}</div>
      </div>
    </button>
  );
}

function SourceBadge({ status }: { status: 'verified' | 'unverifiable' | 'fabricated' | 'not-in-input' }) {
  const styles: Record<string, string> = {
    verified: 'bg-green-100 text-green-700',
    unverifiable: 'bg-yellow-100 text-yellow-700',
    fabricated: 'bg-red-100 text-red-700',
    'not-in-input': 'bg-gray-100 text-gray-500',
  };
  const labels: Record<string, string> = {
    verified: '✓ Source Verified',
    unverifiable: '? Unverifiable',
    fabricated: '🚩 Fabricated',
    'not-in-input': '○ Not in Input',
  };
  return (
    <span className={`shrink-0 text-sm font-bold px-1.5 py-0.5 rounded whitespace-nowrap ${styles[status] || 'bg-gray-100 text-gray-500'}`}>
      {labels[status] || status}
    </span>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center h-48 text-sm text-gray-400 italic">
      {text}
    </div>
  );
}
