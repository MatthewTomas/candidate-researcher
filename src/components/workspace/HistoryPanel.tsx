/**
 * HistoryPanel — Column C of the workspace.
 * Shows completed sessions (from the batch queue "complete" status
 * and any sessions not tied to a queue item).
 */

import React, { useState, useCallback, useMemo } from 'react';
import { useApp } from '../../context/AppContext';
import { exportAsBranchJSON, exportAsMarkdown } from '../../services/exportService';
import type { BatchQueueItem, CandidateSession, BatchItemStatus } from '../../types';

function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function safeName(n: string) {
  return n.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
}

const PARTY_COLORS: Record<string, string> = {
  D: 'bg-blue-100 text-blue-700',
  R: 'bg-red-100 text-red-700',
  I: 'bg-purple-100 text-purple-700',
  L: 'bg-yellow-100 text-yellow-700',
  G: 'bg-emerald-100 text-emerald-700',
};

interface HistoryPanelProps {
  onSelect: (item: BatchQueueItem) => void;
}

export default function HistoryPanel({ onSelect }: HistoryPanelProps) {
  const { batchQueue, sessions, showToast } = useApp();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Completed items from queue
  const completedItems = useMemo(() => batchQueue.filter(i => i.status === 'complete' || i.status === 'skipped'), [batchQueue]);

  // Sessions with no matching queue item (created interactively, pre-workspace)
  const orphanSessions = useMemo(() => {
    const queueSessionIds = new Set(batchQueue.map(i => i.sessionId).filter(Boolean));
    return sessions.filter(
      s => s.status === 'complete' && !queueSessionIds.has(s.id),
    );
  }, [sessions, batchQueue]);

  // Convert orphan sessions to synthetic queue items so the side panel can work with them
  const syntheticItems: BatchQueueItem[] = useMemo(() =>
    orphanSessions.map(s => ({
      id: `synthetic-${s.id}`,
      candidateName: s.candidateName,
      metadata: s.metadata || {},
      status: 'complete' as BatchItemStatus,
      sessionId: s.id,
      completedAt: s.updatedAt,
    })),
  [orphanSessions]);

  const allItems = useMemo(() => {
    const combined = [...completedItems, ...syntheticItems];
    return combined.sort((a, b) => {
      const da = a.completedAt || '';
      const db = b.completedAt || '';
      return db.localeCompare(da);
    });
  }, [completedItems, syntheticItems]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const handleBulkExport = useCallback(() => {
    const selected = allItems.filter(i => selectedIds.has(i.id));
    let count = 0;
    for (const item of selected) {
      const session = sessions.find(s => s.id === item.sessionId);
      if (!session?.currentDraft) continue;
      downloadFile(
        exportAsBranchJSON(session.currentDraft, session.candidateName),
        `${safeName(session.candidateName)}_branch.json`,
        'application/json',
      );
      count++;
    }
    showToast(`Exported ${count} profile(s)`, 'success');
    setSelectedIds(new Set());
  }, [allItems, selectedIds, sessions, showToast]);

  const selectedCompleted = [...selectedIds].filter(id => allItems.find(i => i.id === id));

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100 bg-gray-50/80">
        <div className="flex items-center justify-between mb-1">
          <div>
            <h2 className="text-sm font-bold text-gray-800">History</h2>
            <p className="text-xs text-gray-400">{allItems.length} completed</p>
          </div>
        </div>

        {selectedCompleted.length > 0 && (
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-gray-400">{selectedCompleted.length} selected</span>
            <button
              className="text-xs font-medium text-branch-600 hover:text-branch-700 px-1.5 py-0.5 rounded hover:bg-branch-50"
              onClick={handleBulkExport}
            >
              Export JSON
            </button>
          </div>
        )}
      </div>

      {/* Item list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {allItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-12 px-4">
            <svg className="h-10 w-10 text-gray-200 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-xs font-medium text-gray-400">No completed profiles</p>
            <p className="text-xs text-gray-300 mt-1">Finished candidates appear here</p>
          </div>
        ) : (
          allItems.map(item => (
            <HistoryCard
              key={item.id}
              item={item}
              session={sessions.find(s => s.id === item.sessionId)}
              selected={selectedIds.has(item.id)}
              onToggleSelect={() => toggleSelect(item.id)}
              onClick={() => onSelect(item)}
              onExportJSON={() => {
                const session = sessions.find(s => s.id === item.sessionId);
                if (!session?.currentDraft) { showToast('No draft to export', 'error'); return; }
                downloadFile(exportAsBranchJSON(session.currentDraft, session.candidateName), `${safeName(session.candidateName)}_branch.json`, 'application/json');
                showToast('Exported JSON', 'success');
              }}
              onExportMD={() => {
                const session = sessions.find(s => s.id === item.sessionId);
                if (!session?.currentDraft) { showToast('No draft to export', 'error'); return; }
                downloadFile(exportAsMarkdown(session.currentDraft, session.candidateName), `${safeName(session.candidateName)}_profile.md`, 'text/markdown');
                showToast('Exported Markdown', 'success');
              }}
            />
          ))
        )}
      </div>
    </div>
  );
}

/* ─── History Card ────────────────────────────────────── */

interface HistoryCardProps {
  item: BatchQueueItem;
  session?: CandidateSession;
  selected: boolean;
  onToggleSelect: () => void;
  onClick: () => void;
  onExportJSON: () => void;
  onExportMD: () => void;
}

function HistoryCard({ item, session, selected, onToggleSelect, onClick, onExportJSON, onExportMD }: HistoryCardProps) {
  const [showExport, setShowExport] = useState(false);

  const latestScore = session?.builderRounds?.length
    ? session.builderRounds[session.builderRounds.length - 1].criticFeedback.overallScore
    : null;

  const hasDraft = Boolean(session?.currentDraft);

  const completedAt = item.completedAt
    ? new Date(item.completedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
    : '—';

  return (
    <div
      className={`group rounded-lg border px-2.5 py-2 cursor-pointer transition-all ${
        selected
          ? 'border-branch-300 bg-branch-50 ring-1 ring-branch-200'
          : 'border-gray-100 bg-white hover:border-gray-200 hover:shadow-sm'
      }`}
      onClick={onClick}
    >
      <div className="flex items-start gap-2">
        {/* Checkbox */}
        {hasDraft && (
          <div
            role="checkbox"
            aria-checked={selected}
            className={`mt-0.5 flex-shrink-0 h-3.5 w-3.5 rounded border-2 flex items-center justify-center transition-colors ${
              selected ? 'bg-branch-600 border-branch-600' : 'border-gray-300 hover:border-branch-400'
            }`}
            onClick={e => { e.stopPropagation(); onToggleSelect(); }}
          >
            {selected && (
              <svg className="h-2 w-2 text-white" fill="currentColor" viewBox="0 0 12 12">
                <path d="M10 3L5 8.5 2 5.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
            )}
          </div>
        )}
        {!hasDraft && <div className="flex-shrink-0 w-3.5" />}

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-gray-800 truncate">{item.candidateName}</span>
            {item.metadata?.party && (
              <span className={`shrink-0 text-sm font-bold px-1 py-0.5 rounded ${PARTY_COLORS[item.metadata.party] || 'bg-gray-100 text-gray-700'}`}>
                {item.metadata.party}
              </span>
            )}
            {latestScore !== null && (
              <span className={`shrink-0 text-sm font-bold px-1 py-0.5 rounded ${
                latestScore >= 80 ? 'bg-green-100 text-green-700' :
                latestScore >= 60 ? 'bg-yellow-100 text-yellow-700' :
                'bg-red-100 text-red-700'
              }`}>
                {latestScore}/100
              </span>
            )}
          </div>
          <div className="text-xs text-gray-400 mt-0.5 truncate">
            {[item.metadata?.officeName, item.metadata?.state].filter(Boolean).join(' · ')} · {completedAt}
          </div>
        </div>

        {/* Export dropdown */}
        {hasDraft && (
          <div className="relative shrink-0">
            <button
              className="opacity-0 group-hover:opacity-100 text-sm font-medium text-gray-400 hover:text-gray-600 px-1.5 py-0.5 rounded border border-gray-200 hover:border-gray-300 transition-all"
              onClick={e => { e.stopPropagation(); setShowExport(prev => !prev); }}
            >
              Export ▾
            </button>
            {showExport && (
              <div
                className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-10 min-w-[100px]"
                onClick={e => e.stopPropagation()}
              >
                <button className="w-full text-left px-3 py-1 text-sm text-gray-700 hover:bg-gray-50" onClick={() => { onExportJSON(); setShowExport(false); }}>JSON</button>
                <button className="w-full text-left px-3 py-1 text-sm text-gray-700 hover:bg-gray-50" onClick={() => { onExportMD(); setShowExport(false); }}>Markdown</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
