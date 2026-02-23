/**
 * ProcessingPanel — Column B of the workspace.
 * Shows items currently in the pipeline (importing → building → error/paused)
 * and runs the batch pipeline for items in "importing" status.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useApp } from '../../context/AppContext';
import { runCandidatePipeline } from '../../services/batchPipeline';
import { AI_PROVIDERS } from '../../types';
import type { BatchQueueItem, BatchItemStatus, AIProviderType, CandidateSession } from '../../types';
import { ConfirmDialog } from '../shared';

/* ─── Status config ─────────────────────────────────── */

const STATUS_LABELS: Record<BatchItemStatus, string> = {
  queued: 'Queued',
  importing: 'Importing',
  researching: 'Researching',
  building: 'Writing',
  auditing: 'Building',
  complete: 'Complete',
  error: 'Error',
  skipped: 'Skipped',
  paused: 'Paused',
};

const STATUS_COLORS: Record<BatchItemStatus, string> = {
  queued: 'bg-gray-100 text-gray-600 border-gray-200',
  importing: 'bg-blue-100 text-blue-700 border-blue-200',
  researching: 'bg-cyan-100 text-cyan-700 border-cyan-200',
  building: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  auditing: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  complete: 'bg-green-100 text-green-700 border-green-200',
  error: 'bg-red-100 text-red-700 border-red-200',
  skipped: 'bg-orange-100 text-orange-700 border-orange-200',
  paused: 'bg-gray-100 text-gray-500 border-gray-200',
};

const PARTY_COLORS: Record<string, string> = {
  D: 'bg-blue-100 text-blue-700',
  R: 'bg-red-100 text-red-700',
  I: 'bg-purple-100 text-purple-700',
  L: 'bg-yellow-100 text-yellow-700',
  G: 'bg-emerald-100 text-emerald-700',
};

interface ProcessingPanelProps {
  onSelect: (item: BatchQueueItem) => void;
}

export default function ProcessingPanel({ onSelect }: ProcessingPanelProps) {
  const {
    batchQueue, setBatchQueue, updateQueueItem,
    createSession, updateSession, sessions,
    settings, getProvider, getTrackedProvider, showToast,
  } = useApp();

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingLog, setProcessingLog] = useState<string[]>([]);
  const [bulkAction, setBulkAction] = useState<'pause' | 'requeue' | 'delete' | null>(null);
  const isProcessingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const currentlyProcessingIdRef = useRef<string | null>(null);

  // Items visible in this panel: anything not 'queued' or 'complete' or 'skipped'
  const processingItems = batchQueue.filter(i =>
    i.status === 'importing' || i.status === 'researching' || i.status === 'building' ||
    i.status === 'auditing' || i.status === 'paused' || i.status === 'error'
  );

  /* ─── Run pipeline when "importing" items appear ── */
  useEffect(() => {
    const importingItems = batchQueue.filter(i => i.status === 'importing');
    if (importingItems.length === 0 || isProcessingRef.current) return;
    runBatch(importingItems);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchQueue.filter(i => i.status === 'importing').length]);

  const addLog = useCallback((msg: string) => {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    // Cap at 500 lines — batch log is for monitoring, not forensics
    setProcessingLog(prev => prev.length >= 500 ? [...prev.slice(-499), line] : [...prev, line]);
  }, []);

  const runBatch = useCallback(async (queuedItems: BatchQueueItem[]) => {
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;
    setIsProcessing(true);

    // Pre-flight: check API keys
    const roles = settings.roleAssignments || {};
    const rolesUsed = new Set<AIProviderType>();
    for (const val of Object.values(roles)) {
      if (Array.isArray(val)) val.forEach(v => rolesUsed.add(v.provider));
      else if (val && typeof val === 'object' && 'provider' in val) rolesUsed.add((val as any).provider);
    }
    if (rolesUsed.size === 0) rolesUsed.add('gemini-free' as AIProviderType);

    const missingKeys = [...rolesUsed].filter(p => !settings.apiKeys[p]);
    if (missingKeys.length > 0) {
      const names = missingKeys.map(p => AI_PROVIDERS[p]?.name || p).join(', ');
      showToast(`Missing API key(s): ${names}`, 'error');
      // Revert all importing items back to queued
      setBatchQueue(prev => prev.map(i =>
        i.status === 'importing' ? { ...i, status: 'queued' as BatchItemStatus } : i
      ));
      isProcessingRef.current = false;
      setIsProcessing(false);
      return;
    }

    // Validate API keys
    addLog('Validating API keys…');
    const { createProvider } = await import('../../services/aiProvider');
    const failedProviders: string[] = [];
    for (const provType of [...rolesUsed]) {
      try {
        const provider = await createProvider(provType, settings.apiKeys[provType]!);
        const isValid = await provider.testConnection();
        if (!isValid) failedProviders.push(`${AI_PROVIDERS[provType]?.name || provType}: test failed`);
      } catch (err: any) {
        failedProviders.push(`${AI_PROVIDERS[provType]?.name || provType}: ${err.message}`);
      }
    }
    if (failedProviders.length > 0) {
      addLog(`❌ API key validation failed:\n${failedProviders.join('\n')}`);
      showToast(`API key(s) invalid. Check Settings.`, 'error');
      setBatchQueue(prev => prev.map(i =>
        i.status === 'importing' ? { ...i, status: 'queued' as BatchItemStatus } : i
      ));
      isProcessingRef.current = false;
      setIsProcessing(false);
      return;
    }
    addLog('✅ All API keys valid. Starting batch…');

    for (const item of queuedItems) {
      // Skip if paused/deleted while loop was running
      const current = batchQueue.find(i => i.id === item.id);
      if (current?.status === 'paused') {
        addLog(`⏸ Skipping ${item.candidateName} (paused)`);
        continue;
      }

      let sessionId: string | undefined;
      const candidateLog: string[] = [];
      let latestSession: CandidateSession | null = null;
      let logFlushTimer: ReturnType<typeof setTimeout> | null = null;

      const flushLog = () => {
        if (latestSession) {
          updateSession({ ...latestSession, buildLog: [...candidateLog] });
        }
      };

      const addCandidateLog = (msg: string) => {
        const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
        candidateLog.push(line);
        // Cap per-candidate log at 800 lines to prevent excessive localStorage/state growth
        // (50 candidates × 800 lines × ~100 chars ≈ 4 MB max in the worst case)
        if (candidateLog.length > 800) candidateLog.splice(0, candidateLog.length - 800);
        addLog(msg);
        // Throttled flush: update session buildLog so side panel sees live logs
        if (latestSession) {
          latestSession = { ...latestSession, buildLog: [...candidateLog] };
          if (logFlushTimer) clearTimeout(logFlushTimer);
          logFlushTimer = setTimeout(flushLog, 250);
        }
      };

      try {
        // Create session
        const session = createSession(item.candidateName);
        sessionId = session.id;
        if (item.metadata) {
          session.metadata = item.metadata;
        }
        latestSession = session;
        setBatchQueue(prev => prev.map(i =>
          i.id === item.id ? { ...i, sessionId: session.id, startedAt: new Date().toISOString() } : i
        ));
        addCandidateLog(`[${item.candidateName}] Session created`);

        // Fresh AbortController per candidate — abort() is called from handleBulkPause when paused mid-run
        const abortCtrl = new AbortController();
        abortControllerRef.current = abortCtrl;
        currentlyProcessingIdRef.current = item.id;

        // Run pipeline
        await runCandidatePipeline(
          { session, importedHtml: item.importedHtml, extractedProfile: item.extractedProfile ?? null, sourceUrls: item.sourceUrls, signal: abortCtrl.signal },
          settings,
          { getProvider, getTrackedProvider },
          {
            onStatusChange: (status) => {
              // Don't overwrite paused/queued status — the user explicitly set those
              setBatchQueue(prev => prev.map(i =>
                i.id === item.id && i.status !== 'paused' && i.status !== 'queued'
                  ? { ...i, status: status as BatchItemStatus }
                  : i
              ));
            },
            onLog: (msg) => addCandidateLog(`[${item.candidateName}] ${msg}`),
            onSessionUpdate: (updated) => {
              latestSession = updated;
              updateSession({ ...updated, buildLog: [...candidateLog] });
            },
          },
        );
        // Final flush to ensure all logs are persisted
        if (logFlushTimer) clearTimeout(logFlushTimer);
        flushLog();

        // Clear abort refs for this candidate
        abortControllerRef.current = null;
        currentlyProcessingIdRef.current = null;

        // Mark complete — but respect pause/re-queue if user changed status mid-pipeline
        setBatchQueue(prev => prev.map(i => {
          if (i.id !== item.id) return i;
          if (i.status === 'paused' || i.status === 'queued') return i; // user paused or re-queued — don't overwrite
          return { ...i, status: 'complete' as BatchItemStatus, completedAt: new Date().toISOString() };
        }));
        addCandidateLog(`[${item.candidateName}] ✅ Complete`);
      } catch (err: any) {
        // Clear abort refs
        abortControllerRef.current = null;
        currentlyProcessingIdRef.current = null;

        const isAbort = err instanceof DOMException && err.name === 'AbortError';
        if (isAbort) {
          // Pipeline was cancelled via pause — status already set to 'paused' by handleBulkPause
          addCandidateLog(`[${item.candidateName}] ⏸ Paused mid-pipeline`);
        } else {
          // Mark error — but respect pause/re-queue
          setBatchQueue(prev => prev.map(i => {
            if (i.id !== item.id) return i;
            if (i.status === 'paused' || i.status === 'queued') return i;
            return { ...i, status: 'error' as BatchItemStatus, error: err.message };
          }));
          addCandidateLog(`[${item.candidateName}] ❌ Error: ${err.message}`);
        }
        if (logFlushTimer) clearTimeout(logFlushTimer);
        if (latestSession) {
          updateSession({ ...latestSession, buildLog: [...candidateLog], status: 'complete' });
        } else if (sessionId) {
          const found = sessions.find(s => s.id === sessionId);
          if (found) updateSession({ ...found, buildLog: [...candidateLog], status: 'complete' });
        }
      }
    }

    isProcessingRef.current = false;
    setIsProcessing(false);
    addLog('Batch processing complete.');
    showToast('Batch processing finished', 'success');
  }, [settings, getProvider, createSession, updateSession, sessions, setBatchQueue, addLog, showToast]);

  /* ─── Bulk selection ────────────────────────────── */
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  /* ─── Bulk actions ──────────────────────────────── */
  const handleBulkPause = useCallback(() => {
    const ids = [...selectedIds].filter(id => processingItems.find(i => i.id === id));
    if (ids.length === 0) return;
    setBatchQueue(prev => prev.map(i =>
      ids.includes(i.id) && (i.status === 'building' || i.status === 'auditing' || i.status === 'importing')
        ? { ...i, status: 'paused' as BatchItemStatus }
        : i
    ));
    // Abort the currently-running AI call if the paused item is the one in flight
    if (currentlyProcessingIdRef.current && ids.includes(currentlyProcessingIdRef.current)) {
      abortControllerRef.current?.abort();
    }
    setSelectedIds(new Set());
    setBulkAction(null);
  }, [selectedIds, processingItems, setBatchQueue]);

  const handleBulkRequeue = useCallback(() => {
    const ids = [...selectedIds].filter(id => processingItems.find(i => i.id === id));
    if (ids.length === 0) return;
    setBatchQueue(prev => prev.map(i =>
      ids.includes(i.id) ? { ...i, status: 'queued' as BatchItemStatus, error: undefined, startedAt: undefined } : i
    ));
    setSelectedIds(new Set());
    setBulkAction(null);
    showToast(`Moved ${ids.length} item(s) back to Queue — previous build logs are saved (click item → Log tab)`, 'info');
  }, [selectedIds, processingItems, setBatchQueue, showToast]);

  const handleBulkDelete = useCallback(() => {
    const ids = [...selectedIds].filter(id => processingItems.find(i => i.id === id));
    setBatchQueue(prev => prev.filter(i => !ids.includes(i.id)));
    setSelectedIds(new Set());
    setBulkAction(null);
  }, [selectedIds, processingItems, setBatchQueue]);

  const handleRetryItem = useCallback((id: string) => {
    setBatchQueue(prev => prev.map(i =>
      i.id === id
        ? { ...i, status: 'importing' as BatchItemStatus, error: undefined, startedAt: undefined, completedAt: undefined }
        : i
    ));
  }, [setBatchQueue]);

  const selectedProcessing = [...selectedIds].filter(id => processingItems.find(i => i.id === id));

  return (
    <div className="flex flex-col h-full border-r border-gray-200 bg-white">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100 bg-gray-50/80">
        <div className="flex items-center justify-between mb-1">
          <div>
            <h2 className="text-sm font-bold text-gray-800">Processing</h2>
            <p className="text-xs text-gray-400">
              {processingItems.length} active{isProcessing && <span className="ml-1 text-yellow-600 animate-pulse">· Running…</span>}
            </p>
          </div>
        </div>

        {/* Bulk actions */}
        {selectedProcessing.length > 0 && (
          <div className="flex items-center gap-1.5 mt-1">
            <span className="text-xs text-gray-400">{selectedProcessing.length} selected</span>
            <button className="text-xs font-medium text-yellow-600 hover:text-yellow-700 px-1.5 py-0.5 rounded hover:bg-yellow-50" onClick={handleBulkPause}>Pause</button>
            <button className="text-xs font-medium text-branch-600 hover:text-branch-700 px-1.5 py-0.5 rounded hover:bg-branch-50" onClick={handleBulkRequeue}>← Re-Queue</button>
            <button className="text-xs font-medium text-red-500 hover:text-red-700 px-1.5 py-0.5 rounded hover:bg-red-50" onClick={() => setBulkAction('delete')}>Delete</button>
          </div>
        )}
      </div>

      {/* Item list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {processingItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-12 px-4">
            <svg className="h-10 w-10 text-gray-200 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            <p className="text-xs font-medium text-gray-400">Nothing processing</p>
            <p className="text-xs text-gray-300 mt-1">Select candidates in Queue and click Process</p>
          </div>
        ) : (
          processingItems.map(item => (
            <ProcessingCard
              key={item.id}
              item={item}
              selected={selectedIds.has(item.id)}
              onToggleSelect={() => toggleSelect(item.id)}
              onClick={() => onSelect(item)}
              onRetry={() => handleRetryItem(item.id)}
            />
          ))
        )}
      </div>

      {/* Bulk delete confirm */}
      {bulkAction === 'delete' && (
        <ConfirmDialog
          title="Delete Selected"
          message={`Permanently delete ${selectedProcessing.length} item(s)?`}
          onConfirm={handleBulkDelete}
          onCancel={() => setBulkAction(null)}
        />
      )}
    </div>
  );
}

/* ─── Processing Card ────────────────────────────────── */

interface ProcessingCardProps {
  item: BatchQueueItem;
  selected: boolean;
  onToggleSelect: () => void;
  onClick: () => void;
  onRetry: () => void;
}

function ProcessingCard({ item, selected, onToggleSelect, onClick, onRetry }: ProcessingCardProps) {
  const isActive = item.status === 'building' || item.status === 'auditing' || item.status === 'importing';

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
          </div>
          <div className="text-xs text-gray-400 mt-0.5 truncate">
            {[item.metadata?.officeName, item.metadata?.state].filter(Boolean).join(' · ')}
          </div>
          {item.error && (
            <div className="text-xs text-red-500 mt-0.5 truncate">{item.error.slice(0, 60)}</div>
          )}
        </div>

        {/* Status tag */}
        <div className="flex items-center gap-1.5 shrink-0">
          {item.status === 'error' && (
            <button
              className="text-sm font-medium text-branch-600 hover:text-branch-700 px-1 py-0.5"
              onClick={e => { e.stopPropagation(); onRetry(); }}
            >
              Retry
            </button>
          )}
          <span className={`text-sm font-bold px-1.5 py-0.5 rounded border flex items-center gap-1 ${STATUS_COLORS[item.status]}`}>
            {isActive && (
              <svg className="h-2 w-2 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
            {STATUS_LABELS[item.status]}
          </span>
        </div>
      </div>
    </div>
  );
}


