import React, { useState, useCallback, useMemo } from 'react';
import { useApp } from '../context/AppContext';
import { exportAsBranchJSON, exportAsMarkdown, exportAuditReport } from '../services/exportService';
import { ConfirmDialog, EmptyState } from '../components/shared';
import SessionDetailPanel from '../components/SessionDetailPanel';
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

const STATUS_DISPLAY: Record<string, { label: string; color: string }> = {
  importing: { label: 'Importing', color: 'bg-blue-100 text-blue-700' },
  building: { label: 'Building', color: 'bg-yellow-100 text-yellow-700' },
  'ready-for-audit': { label: 'Ready for Audit', color: 'bg-purple-100 text-purple-700' },
  audited: { label: 'Audited', color: 'bg-green-100 text-green-700' },
  complete: { label: 'Complete', color: 'bg-green-100 text-green-700' },
};

type SortField = 'name' | 'date' | 'status' | 'rounds';
type SortDir = 'asc' | 'desc';

/* ═══════════════════════════ MAIN PAGE ═══════════════════════════════════ */

export default function HistoryPage() {
  const { sessions, removeSession, showToast } = useApp();

  const [selectedSession, setSelectedSession] = useState<CandidateSession | null>(null);
  const [deletingSession, setDeletingSession] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState<SortField>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  /* ─── Filtered & sorted sessions ─────────────────── */
  const filteredSessions = useMemo(() => {
    let list = [...sessions];

    // Search
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(s =>
        s.candidateName.toLowerCase().includes(q) ||
        s.metadata?.officeName?.toLowerCase().includes(q) ||
        s.metadata?.state?.toLowerCase().includes(q)
      );
    }

    // Status filter
    if (statusFilter !== 'all') {
      list = list.filter(s => s.status === statusFilter);
    }

    // Sort
    list.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'name': cmp = a.candidateName.localeCompare(b.candidateName); break;
        case 'date': cmp = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime(); break;
        case 'status': cmp = a.status.localeCompare(b.status); break;
        case 'rounds': cmp = a.builderRounds.length - b.builderRounds.length; break;
      }
      return sortDir === 'desc' ? -cmp : cmp;
    });

    return list;
  }, [sessions, search, statusFilter, sortField, sortDir]);

  /* ─── Export handlers ────────────────────────────── */
  const handleExportJSON = useCallback((session: CandidateSession) => {
    if (!session.currentDraft) return;
    const json = exportAsBranchJSON(session.currentDraft, session.candidateName);
    downloadFile(json, `${session.candidateName.replace(/\s+/g, '_')}_branch.json`, 'application/json');
    showToast('Branch JSON exported', 'success');
  }, [showToast]);

  const handleExportMarkdown = useCallback((session: CandidateSession) => {
    if (!session.currentDraft) return;
    const md = exportAsMarkdown(session.currentDraft, session.candidateName);
    downloadFile(md, `${session.candidateName.replace(/\s+/g, '_')}_profile.md`, 'text/markdown');
    showToast('Markdown exported', 'success');
  }, [showToast]);

  const handleExportAudit = useCallback((session: CandidateSession) => {
    if (!session.auditReports?.length) return;
    const latest = session.auditReports[session.auditReports.length - 1];
    const txt = exportAuditReport(latest);
    downloadFile(txt, `${session.candidateName.replace(/\s+/g, '_')}_audit.txt`, 'text/plain');
    showToast('Audit report exported', 'success');
  }, [showToast]);

  const handleBulkExportJSON = useCallback(() => {
    const exportable = filteredSessions.filter(s => s.currentDraft);
    if (exportable.length === 0) { showToast('No profiles to export', 'info'); return; }
    const allProfiles = exportable.map(s => JSON.parse(exportAsBranchJSON(s.currentDraft!, s.candidateName)));
    const json = JSON.stringify(allProfiles, null, 2);
    downloadFile(json, `branch_profiles_bulk_${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
    showToast(`Exported ${exportable.length} profiles`, 'success');
  }, [filteredSessions, showToast]);

  /* ─── Open session detail panel ──────────────── */
  const handleOpenSession = useCallback((session: CandidateSession) => {
    setSelectedSession(session);
  }, []);

  /* ─── Toggle sort ────────────────────────────────── */
  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  const SortArrow = ({ field }: { field: SortField }) => (
    sortField === field ? (
      <svg className={`h-3 w-3 inline ml-0.5 ${sortDir === 'desc' ? '' : 'rotate-180'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    ) : null
  );

  /* Status counts */
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: sessions.length };
    sessions.forEach(s => { counts[s.status] = (counts[s.status] || 0) + 1; });
    return counts;
  }, [sessions]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">History</h2>
          <p className="text-sm text-gray-500">
            {sessions.length} session{sessions.length !== 1 ? 's' : ''} · View, export, or manage completed profiles
          </p>
        </div>
        {filteredSessions.some(s => s.currentDraft) && (
          <button className="btn-primary text-sm flex items-center gap-1.5" onClick={handleBulkExportJSON}>
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Export All JSON
          </button>
        )}
      </div>

      {sessions.length === 0 ? (
        <EmptyState
          icon={
            <svg className="h-10 w-10 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
          title="No history yet"
          description="Process candidates from the Queue tab to see them here."
        />
      ) : (
        <>
          {/* Filters & search */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex-1 min-w-[200px]">
              <input
                type="text"
                className="input text-sm w-full"
                placeholder="Search by name, office, or state…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-1">
              {(['all', 'building', 'ready-for-audit', 'audited', 'complete'] as const).map(status => (
                <button
                  key={status}
                  onClick={() => setStatusFilter(status)}
                  className={`text-[10px] px-2 py-1 rounded-full font-medium transition-colors ${
                    statusFilter === status
                      ? 'bg-branch-100 text-branch-700'
                      : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                  }`}
                >
                  {status === 'all' ? 'All' : STATUS_DISPLAY[status]?.label || status}
                  {statusCounts[status] ? ` (${statusCounts[status]})` : ''}
                </button>
              ))}
            </div>
          </div>

          {/* Results table */}
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/50">
                  <th className="text-left px-4 py-2.5 font-semibold text-gray-600">
                    <button onClick={() => toggleSort('name')} className="hover:text-gray-900">Candidate<SortArrow field="name" /></button>
                  </th>
                  <th className="text-left px-4 py-2.5 font-semibold text-gray-600">
                    <button onClick={() => toggleSort('status')} className="hover:text-gray-900">Status<SortArrow field="status" /></button>
                  </th>
                  <th className="text-left px-4 py-2.5 font-semibold text-gray-600">
                    <button onClick={() => toggleSort('rounds')} className="hover:text-gray-900">Rounds<SortArrow field="rounds" /></button>
                  </th>
                  <th className="text-left px-4 py-2.5 font-semibold text-gray-600">Audit</th>
                  <th className="text-left px-4 py-2.5 font-semibold text-gray-600">
                    <button onClick={() => toggleSort('date')} className="hover:text-gray-900">Updated<SortArrow field="date" /></button>
                  </th>
                  <th className="text-right px-4 py-2.5 font-semibold text-gray-600">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filteredSessions.map(session => {
                  const latestAudit = session.auditReports?.length
                    ? session.auditReports[session.auditReports.length - 1]
                    : null;
                  const sd = STATUS_DISPLAY[session.status] || { label: session.status, color: 'bg-gray-100 text-gray-600' };

                  return (
                    <tr key={session.id} className="hover:bg-gray-50/50 transition-colors group cursor-pointer" onClick={() => handleOpenSession(session)}>
                      <td className="px-4 py-3">
                        <div>
                          <div className="font-medium text-gray-800">{session.candidateName}</div>
                          <div className="text-[10px] text-gray-400">
                            {[session.metadata?.officeName, session.metadata?.districtName, session.metadata?.state].filter(Boolean).join(' · ') || 'No metadata'}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${sd.color}`}>
                          {sd.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs text-gray-600">{session.builderRounds.length}</span>
                      </td>
                      <td className="px-4 py-3">
                        {latestAudit ? (
                          <div className="text-[10px] space-x-1">
                            <span className="text-green-600 font-medium">{latestAudit.summary.verified}✓</span>
                            <span className="text-red-600 font-medium">{latestAudit.summary.contradicted}✗</span>
                            <span className="text-gray-400">{latestAudit.summary.unverified}?</span>
                          </div>
                        ) : (
                          <span className="text-[10px] text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs text-gray-500">{new Date(session.updatedAt).toLocaleDateString()}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                          <button
                            className="text-[10px] text-branch-600 hover:text-branch-700 font-medium px-1.5 py-0.5 rounded hover:bg-branch-50"
                            onClick={() => handleOpenSession(session)}
                          >
                            Open
                          </button>
                          {session.currentDraft && (
                            <>
                              <button
                                className="text-[10px] text-gray-500 hover:text-gray-700 font-medium px-1.5 py-0.5 rounded hover:bg-gray-100"
                                onClick={() => handleExportJSON(session)}
                                title="Export Branch JSON"
                              >
                                JSON
                              </button>
                              <button
                                className="text-[10px] text-gray-500 hover:text-gray-700 font-medium px-1.5 py-0.5 rounded hover:bg-gray-100"
                                onClick={() => handleExportMarkdown(session)}
                                title="Export Markdown"
                              >
                                MD
                              </button>
                            </>
                          )}
                          {session.auditReports.length > 0 && (
                            <button
                              className="text-[10px] text-gray-500 hover:text-gray-700 font-medium px-1.5 py-0.5 rounded hover:bg-gray-100"
                              onClick={() => handleExportAudit(session)}
                              title="Export Audit Report"
                            >
                              Audit
                            </button>
                          )}
                          <button
                            className="text-[10px] text-red-400 hover:text-red-600 font-medium px-1.5 py-0.5 rounded hover:bg-red-50"
                            onClick={() => setDeletingSession(session.id)}
                            title="Delete session"
                          >
                            ✕
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {filteredSessions.length === 0 && sessions.length > 0 && (
              <div className="text-center py-8 text-sm text-gray-400">
                No sessions match your filters.
              </div>
            )}
          </div>
        </>
      )}

      {/* Delete confirmation */}
      {deletingSession && (
        <ConfirmDialog
          title="Delete Session"
          message="This will permanently delete the session and all its data."
          onConfirm={() => {
            removeSession(deletingSession);
            setDeletingSession(null);
            if (selectedSession?.id === deletingSession) setSelectedSession(null);
            showToast('Session deleted', 'info');
          }}
          onCancel={() => setDeletingSession(null)}
        />
      )}

      {/* Session detail panel */}
      {selectedSession && (
        <SessionDetailPanel
          session={selectedSession}
          onClose={() => setSelectedSession(null)}
          onExportJSON={() => handleExportJSON(selectedSession)}
          onExportMD={() => handleExportMarkdown(selectedSession)}
          onExportAudit={() => handleExportAudit(selectedSession)}
        />
      )}
    </div>
  );
}
