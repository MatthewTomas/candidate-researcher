/**
 * QueuePanel — Column A of the workspace.
 * Shows queued candidates, handles multi-select, and "Move to Processing".
 */

import React, { useState, useCallback } from 'react';
import { useApp } from '../../context/AppContext';
import { ConfirmDialog } from '../shared';
import UploadModal from './UploadModal';
import type { BatchQueueItem, BatchItemStatus } from '../../types';

const PARTY_COLORS: Record<string, string> = {
  D: 'bg-blue-100 text-blue-700',
  R: 'bg-red-100 text-red-700',
  I: 'bg-purple-100 text-purple-700',
  L: 'bg-yellow-100 text-yellow-700',
  G: 'bg-emerald-100 text-emerald-700',
};

interface QueuePanelProps {
  onSelect: (item: BatchQueueItem) => void;
}

export default function QueuePanel({ onSelect }: QueuePanelProps) {
  const { batchQueue, setBatchQueue, removeFromQueue, showToast } = useApp();

  const [showUpload, setShowUpload] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showMoveConfirm, setShowMoveConfirm] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Only show items that are in 'queued' status (not yet picked up by processing)
  const queuedItems = batchQueue.filter(i => i.status === 'queued');

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(queuedItems.map(i => i.id)));
  }, [queuedItems]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const handleMoveToProcessing = useCallback(() => {
    // Move selected items to 'building' status so ProcessingPanel picks them up
    const ids = [...selectedIds].filter(id => queuedItems.find(i => i.id === id));
    if (ids.length === 0) return;
    setBatchQueue(prev =>
      prev.map(i => ids.includes(i.id) ? { ...i, status: 'importing' as BatchItemStatus } : i),
    );
    setSelectedIds(new Set());
    setShowMoveConfirm(false);
    showToast(`Moved ${ids.length} candidate(s) to processing`, 'success');
  }, [selectedIds, queuedItems, setBatchQueue, showToast]);

  const handleRemove = useCallback((id: string) => {
    removeFromQueue([id]);
    setSelectedIds(prev => { const n = new Set(prev); n.delete(id); return n; });
    setDeletingId(null);
  }, [removeFromQueue]);

  const selectedQueued = [...selectedIds].filter(id => queuedItems.find(i => i.id === id));

  return (
    <div className="flex flex-col h-full border-r border-gray-200 bg-white">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100 bg-gray-50/80">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h2 className="text-sm font-bold text-gray-800">Queue</h2>
            <p className="text-xs text-gray-400">{queuedItems.length} waiting</p>
          </div>
          <button
            className="flex items-center gap-1 text-xs font-medium bg-branch-600 text-white px-2.5 py-1.5 rounded-lg hover:bg-branch-700 transition-colors"
            onClick={() => setShowUpload(true)}
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
            Add
          </button>
        </div>

        {/* Select-all / bulk actions */}
        {queuedItems.length > 0 && (
          <div className="flex items-center gap-2">
            <button
              className="text-xs font-medium text-gray-500 hover:text-gray-700 transition-colors"
              onClick={selectedIds.size === queuedItems.length ? clearSelection : selectAll}
            >
              {selectedIds.size === queuedItems.length ? 'Deselect All' : 'Select All'}
            </button>
            {selectedQueued.length > 0 && (
              <>
                <span className="text-gray-300">·</span>
                <span className="text-xs text-gray-400">{selectedQueued.length} selected</span>
                <button
                  className="ml-auto text-xs font-bold bg-branch-600 text-white px-2 py-0.5 rounded-md hover:bg-branch-700 transition-colors"
                  onClick={() => setShowMoveConfirm(true)}
                >
                  Process →
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Item list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {queuedItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-12 px-4">
            <svg className="h-10 w-10 text-gray-200 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
            <p className="text-xs font-medium text-gray-400">No candidates queued</p>
            <p className="text-xs text-gray-300 mt-1">Click Add to upload CSV, JSON, or HTML</p>
          </div>
        ) : (
          queuedItems.map(item => (
            <QueueCard
              key={item.id}
              item={item}
              selected={selectedIds.has(item.id)}
              onToggleSelect={() => toggleSelect(item.id)}
              onClick={() => onSelect(item)}
              onRemove={() => setDeletingId(item.id)}
            />
          ))
        )}
      </div>

      {/* Upload modal */}
      {showUpload && <UploadModal onClose={() => setShowUpload(false)} />}

      {/* Move confirmation */}
      {showMoveConfirm && (
        <ConfirmDialog
          title="Move to Processing"
          message={`Send ${selectedQueued.length} candidate${selectedQueued.length !== 1 ? 's' : ''} to the processing queue? This will start pipeline execution.`}
          onConfirm={handleMoveToProcessing}
          onCancel={() => setShowMoveConfirm(false)}
        />
      )}

      {/* Delete confirmation */}
      {deletingId && (
        <ConfirmDialog
          title="Remove Candidate"
          message="Remove this candidate from the queue?"
          onConfirm={() => handleRemove(deletingId)}
          onCancel={() => setDeletingId(null)}
        />
      )}
    </div>
  );
}

/* ─── Queue Card ─────────────────────────────────────── */

interface QueueCardProps {
  item: BatchQueueItem;
  selected: boolean;
  onToggleSelect: () => void;
  onClick: () => void;
  onRemove: () => void;
}

function QueueCard({ item, selected, onToggleSelect, onClick, onRemove }: QueueCardProps) {
  const isHtml = Boolean(item.importedHtml);

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

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-gray-800 truncate">{item.candidateName}</span>
            {item.metadata?.party && (
              <span className={`shrink-0 text-sm font-bold px-1 py-0.5 rounded ${PARTY_COLORS[item.metadata.party] || 'bg-gray-100 text-gray-700'}`}>
                {item.metadata.party}
              </span>
            )}
            {isHtml && (
              <span className="shrink-0 text-sm font-medium px-1 py-0.5 rounded bg-orange-100 text-orange-700">HTML</span>
            )}
          </div>
          <div className="text-xs text-gray-400 mt-0.5 truncate">
            {[item.metadata?.officeName, item.metadata?.districtName, item.metadata?.state].filter(Boolean).join(' · ') || (isHtml ? 'Imported from HTML' : '')}
          </div>
        </div>

        {/* Remove */}
        <button
          className="opacity-0 group-hover:opacity-100 flex-shrink-0 text-gray-300 hover:text-red-500 transition-all"
          onClick={e => { e.stopPropagation(); onRemove(); }}
          title="Remove"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
