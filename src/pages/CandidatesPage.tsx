import React, { useState, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { ConfirmDialog, EmptyState, Spinner } from '../components/shared';
import CandidateSidePanel from '../components/CandidateSidePanel';
import { extractTextFromHtml, extractLinksFromHtml, extractBranchProfile, sanitizeHtmlForPreview } from '../services/htmlExtractor';
import { runCandidatePipeline } from '../services/batchPipeline';
import type { BatchQueueItem, CandidateMetadata, BatchItemStatus, ExtractedProfile, AIProviderType, CandidateSession } from '../types';
import { AI_PROVIDERS } from '../types';
import { v4 as uuid } from 'uuid';

/* ─── Constants ──────────────────────────────────── */

const STATUS_COLORS: Record<BatchItemStatus, string> = {
  queued: 'bg-gray-100 text-gray-700 border-gray-200',
  importing: 'bg-blue-100 text-blue-700 border-blue-200',
  building: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  auditing: 'bg-purple-100 text-purple-700 border-purple-200',
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

interface ParsedCandidate {
  candidateName: string;
  metadata: CandidateMetadata;
}

type ColumnId = 'unqueued' | 'queued' | 'complete';
type AddTab = 'csv-json' | 'html';

export default function CandidatesPage() {
  const { createSession, setActiveSession, updateSession, sessions, settings, getProvider, showToast, batchQueue: items, setBatchQueue: setItems, addToQueue, removeFromQueue } = useApp();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const htmlFileInputRef = useRef<HTMLInputElement>(null);

  // Queue state (items/setItems come from AppContext — persisted to localStorage)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [parseError, setParseError] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [addTab, setAddTab] = useState<AddTab>('csv-json');
  const [rawInput, setRawInput] = useState('');
  const [inputFormat, setInputFormat] = useState<'json' | 'csv'>('json');
  const [deletingItem, setDeletingItem] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingLog, setProcessingLog] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);

  // HTML import state (inside modal)
  const [htmlInput, setHtmlInput] = useState('');
  const [htmlCandidateName, setHtmlCandidateName] = useState('');
  const [htmlPreviewProfile, setHtmlPreviewProfile] = useState<ExtractedProfile | null>(null);
  const [htmlProcessing, setHtmlProcessing] = useState(false);

  // Drag state
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<ColumnId | null>(null);

  // Side panel
  const [panelItem, setPanelItem] = useState<BatchQueueItem | null>(null);

  /* ─── Derived columns ───────────────────────────── */
  const columns = useMemo(() => {
    const unqueued = items.filter(i =>
      i.status === 'queued' && !selectedIds.has(i.id));
    const queued = items.filter(i =>
      selectedIds.has(i.id) || i.status === 'importing' || i.status === 'building' || i.status === 'auditing');
    const complete = items.filter(i =>
      i.status === 'complete' || i.status === 'error' || i.status === 'skipped');
    return { unqueued, queued, complete };
  }, [items, selectedIds]);

  /* ─── CSV/JSON file upload ──────────────────────── */
  const handleFileUpload = useCallback((file: File) => {
    setParseError(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      if (!content) return;
      try {
        let candidates: ParsedCandidate[];
        if (file.name.endsWith('.csv')) {
          candidates = parseCsv(content);
        } else {
          candidates = parseJson(content);
        }
        const newItems: BatchQueueItem[] = candidates.map(c => ({
          id: uuid(),
          candidateName: c.candidateName,
          metadata: c.metadata,
          status: 'queued' as BatchItemStatus,
        }));
        addToQueue(newItems);
        showToast(`Loaded ${newItems.length} candidate(s) from ${file.name}`, 'success');
        setShowAddModal(false);
        setRawInput('');
      } catch (err: any) {
        setParseError(err.message);
      }
    };
    reader.readAsText(file);
  }, [showToast]);

  /* ─── Parse from text input (CSV/JSON) ──────────── */
  const handleParseInput = useCallback(() => {
    setParseError(null);
    try {
      let candidates: ParsedCandidate[];
      if (inputFormat === 'csv') {
        candidates = parseCsv(rawInput);
      } else {
        candidates = parseJson(rawInput);
      }
      const newItems: BatchQueueItem[] = candidates.map(c => ({
        id: uuid(),
        candidateName: c.candidateName,
        metadata: c.metadata,
        status: 'queued' as BatchItemStatus,
      }));
      addToQueue(newItems);
      showToast(`Added ${newItems.length} candidate(s)`, 'success');
      setShowAddModal(false);
      setRawInput('');
    } catch (err: any) {
      setParseError(err.message);
    }
  }, [rawInput, inputFormat, showToast]);

  /* ─── HTML file upload ──────────────────────────── */
  const handleHtmlFileUpload = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      if (content) {
        setHtmlInput(content);
        showToast(`Loaded ${file.name} (${(content.length / 1024).toFixed(1)} KB)`, 'success');
      }
    };
    reader.readAsText(file);
  }, [showToast]);

  /* ─── Process HTML and add to queue ─────────────── */
  const handleProcessHtml = useCallback(() => {
    if (!htmlInput.trim()) {
      showToast('Please paste HTML or upload a file first', 'error');
      return;
    }
    setHtmlProcessing(true);
    try {
      const profile = extractBranchProfile(htmlInput);
      setHtmlPreviewProfile(profile);
      if (profile.candidateName && !htmlCandidateName) {
        setHtmlCandidateName(profile.candidateName);
      }
      showToast('HTML processed — review and add to queue', 'success');
    } catch (err: any) {
      showToast(`HTML extraction failed: ${err.message}`, 'error');
    } finally {
      setHtmlProcessing(false);
    }
  }, [htmlInput, htmlCandidateName, showToast]);

  const handleAddHtmlCandidate = useCallback(() => {
    const name = htmlCandidateName.trim() || htmlPreviewProfile?.candidateName || 'Untitled Candidate';
    const item: BatchQueueItem = {
      id: uuid(),
      candidateName: name,
      metadata: {},
      status: 'queued' as BatchItemStatus,
      importedHtml: htmlInput,
      extractedProfile: htmlPreviewProfile,
    };
    addToQueue([item]);
    showToast(`Added ${name} (HTML import) to queue`, 'success');
    // Reset HTML modal state
    setHtmlInput('');
    setHtmlCandidateName('');
    setHtmlPreviewProfile(null);
    setShowAddModal(false);
  }, [htmlCandidateName, htmlInput, htmlPreviewProfile, showToast]);

  /* ─── Selection ─────────────────────────────────── */
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const dequeueAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  /* ─── Drag and Drop (fixed with enter counter) ─── */
  const dragCounterRef = useRef<Record<string, number>>({});

  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    setDraggedId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
    // Set a drag image — slight delay for visual feedback
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '0.4';
    }
  }, []);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    setDraggedId(null);
    setDragOverColumn(null);
    dragCounterRef.current = {};
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '1';
    }
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent, column: ColumnId) => {
    e.preventDefault();
    dragCounterRef.current[column] = (dragCounterRef.current[column] || 0) + 1;
    setDragOverColumn(column);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent, column: ColumnId) => {
    e.preventDefault();
    dragCounterRef.current[column] = (dragCounterRef.current[column] || 0) - 1;
    if (dragCounterRef.current[column] <= 0) {
      dragCounterRef.current[column] = 0;
      if (dragOverColumn === column) {
        setDragOverColumn(null);
      }
    }
  }, [dragOverColumn]);

  const handleDrop = useCallback((e: React.DragEvent, targetColumn: ColumnId) => {
    e.preventDefault();
    setDragOverColumn(null);
    dragCounterRef.current = {};
    const id = e.dataTransfer.getData('text/plain');
    if (!id) return;

    const item = items.find(i => i.id === id);
    if (!item) return;

    if (targetColumn === 'queued') {
      // Move to batch queue
      setSelectedIds(prev => new Set([...prev, id]));
    } else if (targetColumn === 'unqueued') {
      // Move back to candidates pool
      setSelectedIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      if (item.status !== 'queued') {
        setItems(prev => prev.map(i => i.id === id ? { ...i, status: 'queued' as BatchItemStatus } : i));
      }
    }
    setDraggedId(null);
  }, [items]);

  /* ─── Process queue — real AI pipeline ──────────── */
  const processQueue = useCallback(async () => {
    if (isProcessing) return; // Guard against concurrent invocations
    const queuedItems = items.filter(i => selectedIds.has(i.id) && i.status === 'queued');
    if (queuedItems.length === 0) {
      showToast('No queued items to process', 'info');
      return;
    }
    setIsProcessing(true);
    setProcessingLog([]);
    setShowLog(true);

    const addLog = (msg: string) =>
      setProcessingLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);

    // Pre-flight: check that all role-assigned providers have API keys configured
    const roles = settings.roleAssignments || {};
    const rolesUsed = new Set<AIProviderType>();
    for (const val of Object.values(roles)) {
      if (Array.isArray(val)) {
        val.forEach(v => rolesUsed.add(v.provider));
      } else if (val && typeof val === 'object' && 'provider' in val) {
        rolesUsed.add((val as { provider: AIProviderType }).provider);
      }
    }
    // If no roles are set, default is gemini-free for everything
    if (rolesUsed.size === 0) rolesUsed.add('gemini-free' as AIProviderType);

    const missingKeys = [...rolesUsed].filter(p => !settings.apiKeys[p]);
    if (missingKeys.length > 0) {
      const names = missingKeys.map(p => AI_PROVIDERS[p]?.name || p).join(', ');
      showToast(`Missing API key(s): ${names}. Go to Settings to add them.`, 'error');
      setIsProcessing(false);
      return;
    }

    // Validate API keys actually work before running the full batch
    addLog('Validating API keys…');
    const providersToTest = [...rolesUsed];
    const { createProvider } = await import('../services/aiProvider');
    const failedProviders: string[] = [];
    for (const provType of providersToTest) {
      try {
        const provider = await createProvider(provType, settings.apiKeys[provType]!);
        const isValid = await provider.testConnection();
        if (!isValid) {
          failedProviders.push(`${AI_PROVIDERS[provType]?.name || provType}: connection test failed — key may be invalid`);
        }
      } catch (err: any) {
        failedProviders.push(`${AI_PROVIDERS[provType]?.name || provType}: ${err.message}`);
      }
    }
    if (failedProviders.length > 0) {
      addLog(`❌ API key validation failed:\n${failedProviders.join('\n')}`);
      showToast(`API key(s) invalid: ${failedProviders.map(f => f.split(':')[0]).join(', ')}. Test them in Settings.`, 'error');
      setIsProcessing(false);
      return;
    }
    addLog('✅ All API keys validated successfully.');

    addLog(`Starting batch processing of ${queuedItems.length} candidate(s)…`);

    // Per-candidate log accumulator — written to session.buildLog on every update
    const candidateLogs = new Map<string, string[]>();

    for (const item of queuedItems) {
      let sessionId: string | undefined;
      const candidateLog: string[] = [];
      candidateLogs.set(item.id, candidateLog);

      const addCandidateLog = (msg: string) => {
        const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
        candidateLog.push(line);
        addLog(msg);
      };

      try {
        // 1. Create session
        setItems(prev => prev.map(i =>
          i.id === item.id
            ? { ...i, status: 'importing' as BatchItemStatus, startedAt: new Date().toISOString() }
            : i
        ));

        const session = createSession(item.candidateName);
        sessionId = session.id;
        setItems(prev => prev.map(i =>
          i.id === item.id ? { ...i, sessionId: session.id } : i
        ));

        addCandidateLog(`[${item.candidateName}] Session created`);

        // 2. Run pipeline
        await runCandidatePipeline(
          {
            session,
            importedHtml: item.importedHtml,
            extractedProfile: item.extractedProfile,
          },
          settings,
          { getProvider },
          {
            onStatusChange: (status) => {
              setItems(prev => prev.map(i =>
                i.id === item.id ? { ...i, status: status as BatchItemStatus } : i
              ));
            },
            onLog: (msg) => addCandidateLog(`[${item.candidateName}] ${msg}`),
            onSessionUpdate: (updated) => {
              // Sync accumulated log to session.buildLog on every update
              updateSession({ ...updated, buildLog: [...candidateLog] });
            },
          },
        );

        // 3. Mark complete
        setItems(prev => prev.map(i =>
          i.id === item.id
            ? { ...i, status: 'complete' as BatchItemStatus, completedAt: new Date().toISOString() }
            : i
        ));
        setSelectedIds(prev => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });

        addCandidateLog(`[${item.candidateName}] ✅ Complete`);
      } catch (err: any) {
        setItems(prev => prev.map(i =>
          i.id === item.id ? { ...i, status: 'error' as BatchItemStatus, error: err.message } : i
        ));
        setSelectedIds(prev => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
        addCandidateLog(`[${item.candidateName}] ❌ Error: ${err.message}`);

        // Sync error log to session even on failure
        if (sessionId) {
          const found = sessions.find(s => s.id === sessionId);
          if (found) {
            updateSession({ ...found, buildLog: [...candidateLog], status: 'complete' });
          }
        }
      }
    }

    setIsProcessing(false);
    addLog(`Batch processing complete.`);
    showToast('Batch processing finished', 'success');
  }, [items, selectedIds, settings, getProvider, createSession, updateSession, sessions, showToast]);

  /* ─── Start single candidate (interactive) ──────── */
  const handleStartCandidate = useCallback((item: BatchQueueItem) => {
    const session = createSession(item.candidateName);
    // If HTML import, store the data on the session
    if (item.importedHtml) {
      const updated = {
        ...session,
        importedHtml: item.importedHtml,
        extractedProfile: item.extractedProfile || null,
        additionalSources: item.importedHtml
          ? extractLinksFromHtml(item.importedHtml)
            .filter(l => l.url)
            .map(l => ({ url: l.url, title: l.title || l.url, addedAt: new Date().toISOString() }))
          : [],
      };
      updateSession(updated);
    }
    setItems(prev => prev.map(i =>
      i.id === item.id
        ? { ...i, sessionId: session.id, status: 'complete' as BatchItemStatus, startedAt: new Date().toISOString() }
        : i
    ));
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.delete(item.id);
      return next;
    });
    setActiveSession(session);
    // HTML imports → go to audit; CSV/JSON → go to build
    navigate(item.importedHtml ? '/audit' : '/build');
    showToast(`Started ${item.candidateName}`, 'success');
  }, [createSession, updateSession, setActiveSession, navigate, showToast]);

  /* ─── Remove from queue ─────────────────────────── */
  const handleRemove = useCallback((id: string) => {
    removeFromQueue([id]);
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setDeletingItem(null);
  }, []);

  /* ─── View completed session (side panel) ──────── */
  const handleViewSession = useCallback((item: BatchQueueItem) => {
    setPanelItem(item);
  }, []);

  /* ─── Retry a single failed item ────────────────── */
  const handleRetryItem = useCallback((itemId: string) => {
    setItems(prev => prev.map(i =>
      i.id === itemId ? { ...i, status: 'queued' as BatchItemStatus, error: undefined, startedAt: undefined, completedAt: undefined } : i,
    ));
    setSelectedIds(prev => new Set([...prev, itemId]));
    showToast('Item re-queued for processing', 'info');
  }, [showToast]);

  /* ─── Retry all failed items ────────────────────── */
  const handleRetryAllFailed = useCallback(() => {
    const failedIds: string[] = [];
    setItems(prev => prev.map(i => {
      if (i.status === 'error') {
        failedIds.push(i.id);
        return { ...i, status: 'queued' as BatchItemStatus, error: undefined, startedAt: undefined, completedAt: undefined };
      }
      return i;
    }));
    setSelectedIds(prev => new Set([...prev, ...failedIds]));
    showToast(`Re-queued ${failedIds.length} failed candidate(s)`, 'info');
  }, [showToast]);

  /* ─── Render ────────────────────────────────────── */
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Candidates</h2>
          <p className="text-sm text-gray-500">
            Import candidates via CSV/JSON or HTML. Drag between columns, then Run All.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="btn-primary text-sm flex items-center gap-1.5"
            onClick={() => { setShowAddModal(true); setParseError(null); }}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
            Add Candidates
          </button>
          {items.length > 0 && (
            <span className="text-xs text-gray-400">
              {items.length} total · {columns.complete.length} done
            </span>
          )}
        </div>
      </div>

      {/* Processing log (collapsible) */}
      {processingLog.length > 0 && (
        <div className="card overflow-hidden">
          <button
            className="w-full px-4 py-2 bg-gray-50 text-left flex items-center justify-between hover:bg-gray-100 transition-colors"
            onClick={() => setShowLog(prev => !prev)}
          >
            <span className="text-xs font-semibold text-gray-600">
              Processing Log ({processingLog.length} entries)
              {isProcessing && <span className="ml-2 text-branch-600 animate-pulse">Running…</span>}
            </span>
            <svg className={`h-4 w-4 text-gray-400 transition-transform ${showLog ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {showLog && (
            <div className="px-4 py-3 max-h-48 overflow-y-auto bg-gray-900 text-gray-200 font-mono text-[11px] leading-relaxed">
              {processingLog.map((line, i) => (
                <div key={i} className={
                  line.includes('✅') ? 'text-green-400' :
                  line.includes('❌') ? 'text-red-400' :
                  line.includes('⚠') ? 'text-yellow-400' :
                  'text-gray-300'
                }>{line}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Three-column drag-and-drop queue */}
      {items.length === 0 ? (
        <EmptyState
          icon={
            <svg className="h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          }
          title="No Candidates Yet"
          description="Click 'Add Candidates' to upload a CSV/JSON file, paste candidate data, or import an HTML profile."
          action={
            <button className="btn-primary text-sm mt-2" onClick={() => setShowAddModal(true)}>
              Add Candidates
            </button>
          }
        />
      ) : (
        <div className="grid grid-cols-3 gap-4 min-h-[400px]">
          {/* Column 1: Unqueued */}
          <QueueColumn
            title="Candidates"
            subtitle={`${columns.unqueued.length} waiting`}
            columnId="unqueued"
            items={columns.unqueued}
            dragOverColumn={dragOverColumn}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            headerColor="bg-gray-50 border-gray-200"
            headerActions={
              columns.unqueued.length > 0 ? (
                <button
                  className="text-[10px] font-medium text-branch-600 hover:text-branch-700"
                  onClick={() => {
                    const ids = columns.unqueued.map(i => i.id);
                    setSelectedIds(prev => new Set([...prev, ...ids]));
                  }}
                >
                  Queue All &rarr;
                </button>
              ) : null
            }
            renderItem={(item) => (
              <CandidateCard
                key={item.id}
                item={item}
                draggable
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                draggedId={draggedId}
                onRemove={() => setDeletingItem(item.id)}
                onClick={() => setPanelItem(item)}
                actions={
                  <button
                    className="text-[10px] text-branch-600 hover:text-branch-700 font-medium"
                    onClick={(e) => { e.stopPropagation(); toggleSelect(item.id); }}
                  >
                    Queue &rarr;
                  </button>
                }
              />
            )}
          />

          {/* Column 2: Batch Queue */}
          <QueueColumn
            title="Batch Queue"
            subtitle={`${columns.queued.length} ready`}
            columnId="queued"
            items={columns.queued}
            dragOverColumn={dragOverColumn}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            headerColor="bg-branch-50 border-branch-200"
            headerActions={
              columns.queued.length > 0 ? (
                <div className="flex items-center gap-2">
                  <button
                    className="text-[10px] font-medium text-gray-400 hover:text-gray-600"
                    onClick={dequeueAll}
                  >
                    &larr; Clear
                  </button>
                  <button
                    className={`flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded ${
                      isProcessing
                        ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                        : 'bg-branch-600 text-white hover:bg-branch-700'
                    }`}
                    disabled={isProcessing}
                    onClick={processQueue}
                  >
                    {isProcessing ? (
                      <>
                        <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        Processing&hellip;
                      </>
                    ) : (
                      <>
                        <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M8 5v14l11-7z" />
                        </svg>
                        Run All
                      </>
                    )}
                  </button>
                </div>
              ) : null
            }
            emptyMessage="Drag candidates here or click 'Queue'"
            renderItem={(item) => (
              <CandidateCard
                key={item.id}
                item={item}
                draggable={item.status === 'queued'}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                draggedId={draggedId}
                onRemove={() => setDeletingItem(item.id)}
                onClick={() => setPanelItem(item)}
                actions={
                  item.status === 'queued' ? (
                    <button
                      className="text-[10px] text-green-600 hover:text-green-700 font-medium"
                      onClick={(e) => { e.stopPropagation(); handleStartCandidate(item); }}
                    >
                      Start &rarr;
                    </button>
                  ) : (
                    <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded border ${STATUS_COLORS[item.status]}`}>
                      {item.status}
                    </span>
                  )
                }
              />
            )}
          />

          {/* Column 3: Complete */}
          <QueueColumn
            title="Complete"
            subtitle={`${columns.complete.length} done`}
            columnId="complete"
            items={columns.complete}
            dragOverColumn={dragOverColumn}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            headerColor="bg-green-50 border-green-200"
            emptyMessage="Completed candidates appear here"
            headerActions={
              columns.complete.some(i => i.status === 'error') ? (
                <button
                  className="text-[10px] text-red-600 hover:text-red-700 font-medium"
                  onClick={handleRetryAllFailed}
                  disabled={isProcessing}
                >
                  Retry Failed
                </button>
              ) : undefined
            }
            renderItem={(item) => (
              <CandidateCard
                key={item.id}
                item={item}
                draggable={false}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                draggedId={draggedId}
                onRemove={() => setDeletingItem(item.id)}
                onClick={() => setPanelItem(item)}
                actions={
                  item.sessionId ? (
                    <button
                      className="text-[10px] text-branch-600 hover:text-branch-700 font-medium"
                      onClick={(e) => { e.stopPropagation(); handleViewSession(item); }}
                    >
                      View &rarr;
                    </button>
                  ) : item.status === 'error' ? (
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-red-500 max-w-[100px] truncate" title={item.error}>
                        {item.error?.slice(0, 40) || 'Failed'}
                      </span>
                      <button
                        className="text-[10px] text-branch-600 hover:text-branch-700 font-medium"
                        onClick={(e) => { e.stopPropagation(); handleRetryItem(item.id); }}
                        disabled={isProcessing}
                      >
                        Retry
                      </button>
                    </div>
                  ) : null
                }
              />
            )}
          />
        </div>
      )}

      {/* ─── Add Candidates Modal ─────────────────── */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setShowAddModal(false)}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="p-6 space-y-4">
              {/* Modal header */}
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold text-gray-900">Add Candidates</h3>
                <button className="text-gray-400 hover:text-gray-600" onClick={() => setShowAddModal(false)}>
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Tab bar */}
              <div className="flex rounded-lg overflow-hidden border border-gray-200">
                <button
                  className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
                    addTab === 'csv-json' ? 'bg-branch-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                  }`}
                  onClick={() => setAddTab('csv-json')}
                >
                  CSV / JSON
                </button>
                <button
                  className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
                    addTab === 'html' ? 'bg-branch-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                  }`}
                  onClick={() => setAddTab('html')}
                >
                  HTML Import
                </button>
              </div>

              {/* ─── CSV/JSON Tab ──────────────────── */}
              {addTab === 'csv-json' && (
                <div className="space-y-4">
                  {/* File upload */}
                  <div
                    className="border-2 border-dashed border-gray-200 rounded-xl p-8 text-center hover:border-branch-300 cursor-pointer transition-colors group"
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
                    onDrop={e => {
                      e.preventDefault();
                      e.stopPropagation();
                      const file = e.dataTransfer.files[0];
                      if (file) handleFileUpload(file);
                    }}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".json,.csv"
                      className="hidden"
                      onChange={e => {
                        const file = e.target.files?.[0];
                        if (file) handleFileUpload(file);
                        e.target.value = '';
                      }}
                    />
                    <svg className="mx-auto h-10 w-10 text-gray-300 group-hover:text-branch-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                    </svg>
                    <p className="mt-3 text-sm font-medium text-gray-600">
                      Drop a file or <span className="text-branch-600">click to browse</span>
                    </p>
                    <p className="mt-1 text-xs text-gray-400">Accepts .json or .csv files</p>
                  </div>

                  {/* Divider */}
                  <div className="flex items-center gap-3">
                    <div className="flex-1 border-t border-gray-200" />
                    <span className="text-xs text-gray-400 font-medium">OR PASTE DATA</span>
                    <div className="flex-1 border-t border-gray-200" />
                  </div>

                  {/* Format toggle + text input */}
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-500 font-medium">Format:</label>
                    <div className="flex rounded-lg overflow-hidden border border-gray-200">
                      <button
                        className={`px-3 py-1 text-xs font-medium ${inputFormat === 'json' ? 'bg-branch-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                        onClick={() => setInputFormat('json')}
                      >
                        JSON
                      </button>
                      <button
                        className={`px-3 py-1 text-xs font-medium ${inputFormat === 'csv' ? 'bg-branch-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                        onClick={() => setInputFormat('csv')}
                      >
                        CSV
                      </button>
                    </div>
                  </div>

                  <textarea
                    className="w-full border border-gray-200 rounded-lg p-3 font-mono text-xs resize-none focus:ring-2 focus:ring-branch-500 focus:border-branch-500"
                    rows={10}
                    placeholder={inputFormat === 'json'
                      ? `[\n  {\n    "name": "Jane Smith",\n    "party": "D",\n    "state": "TX",\n    "officeName": "State Representative",\n    "districtName": "District 50",\n    "election": "2026-texas-primary"\n  }\n]`
                      : `name,party,state,officeName,districtName,election\nJane Smith,D,TX,State Representative,District 50,2026-texas-primary`
                    }
                    value={rawInput}
                    onChange={e => setRawInput(e.target.value)}
                    onPaste={e => e.stopPropagation()}
                  />

                  {parseError && (
                    <div className="text-xs text-red-600 bg-red-50 rounded-lg p-3">
                      <strong>Parse error:</strong> {parseError}
                    </div>
                  )}

                  {/* Expected fields */}
                  <details className="text-xs">
                    <summary className="font-semibold text-gray-600 cursor-pointer hover:text-gray-800">
                      Expected Fields
                    </summary>
                    <div className="grid grid-cols-3 gap-1.5 mt-2">
                      {[
                        ['name', 'Candidate name (required)'],
                        ['party', 'D / R / I / L / G'],
                        ['state', 'Two-letter state code'],
                        ['officeName', "e.g. 'District Attorney'"],
                        ['districtName', "e.g. 'Bexar County'"],
                        ['districtType', 'county / state / city'],
                        ['election', "e.g. '2026-texas-primary'"],
                        ['raceKey', 'Branch race key'],
                        ['issuesToCover', 'Comma-separated issues'],
                      ].map(([field, desc]) => (
                        <div key={field} className="bg-gray-50 rounded px-2 py-1">
                          <span className="font-mono text-gray-700">{field}</span>
                          <span className="text-gray-400 ml-1">{desc}</span>
                        </div>
                      ))}
                    </div>
                  </details>

                  <div className="flex items-center justify-end gap-3 pt-2">
                    <button className="btn-secondary text-sm" onClick={() => setShowAddModal(false)}>
                      Cancel
                    </button>
                    <button
                      className="btn-primary text-sm"
                      onClick={handleParseInput}
                      disabled={!rawInput.trim()}
                    >
                      Add to Queue
                    </button>
                  </div>
                </div>
              )}

              {/* ─── HTML Import Tab ──────────────── */}
              {addTab === 'html' && (
                <div className="space-y-4">
                  <p className="text-xs text-gray-500">
                    Import an existing candidate profile from HTML. This candidate will go straight to the
                    fact-checking/audit step since they already have profile data.
                  </p>

                  {/* Candidate name */}
                  <div>
                    <label className="text-xs font-medium text-gray-600">Candidate Name</label>
                    <input
                      className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-branch-500 focus:border-branch-500"
                      placeholder="e.g., Jane Smith"
                      value={htmlCandidateName}
                      onChange={e => setHtmlCandidateName(e.target.value)}
                    />
                  </div>

                  {/* HTML file upload */}
                  <div
                    className="border-2 border-dashed border-gray-200 rounded-xl p-6 text-center hover:border-branch-300 cursor-pointer transition-colors group"
                    onClick={() => htmlFileInputRef.current?.click()}
                    onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
                    onDrop={e => {
                      e.preventDefault();
                      e.stopPropagation();
                      const file = e.dataTransfer.files[0];
                      if (file) handleHtmlFileUpload(file);
                    }}
                  >
                    <input
                      ref={htmlFileInputRef}
                      type="file"
                      accept=".html,.htm,.txt,.mhtml"
                      className="hidden"
                      onChange={e => {
                        const file = e.target.files?.[0];
                        if (file) handleHtmlFileUpload(file);
                        e.target.value = '';
                      }}
                    />
                    <svg className="mx-auto h-8 w-8 text-gray-300 group-hover:text-branch-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                    </svg>
                    <p className="mt-2 text-sm font-medium text-gray-600">
                      Drop an HTML file or <span className="text-branch-600">click to browse</span>
                    </p>
                  </div>

                  {/* Divider */}
                  <div className="flex items-center gap-3">
                    <div className="flex-1 border-t border-gray-200" />
                    <span className="text-xs text-gray-400 font-medium">OR PASTE HTML</span>
                    <div className="flex-1 border-t border-gray-200" />
                  </div>

                  {/* HTML textarea */}
                  <textarea
                    className="w-full border border-gray-200 rounded-lg p-3 font-mono text-xs resize-none focus:ring-2 focus:ring-branch-500 focus:border-branch-500"
                    rows={8}
                    placeholder="Paste HTML source here…"
                    value={htmlInput}
                    onChange={e => setHtmlInput(e.target.value)}
                    onPaste={e => {
                      e.stopPropagation();
                      const html = e.clipboardData.getData('text/html');
                      const text = e.clipboardData.getData('text/plain');
                      const content = html || text;
                      if (content) {
                        e.preventDefault();
                        setHtmlInput(content);
                      }
                    }}
                  />

                  {htmlInput && (
                    <div className="text-xs text-gray-400">
                      {(htmlInput.length / 1024).toFixed(1)} KB loaded
                    </div>
                  )}

                  {/* Process / Preview */}
                  {!htmlPreviewProfile ? (
                    <div className="flex items-center justify-end gap-3 pt-2">
                      <button className="btn-secondary text-sm" onClick={() => setShowAddModal(false)}>
                        Cancel
                      </button>
                      <button
                        className="btn-primary text-sm"
                        onClick={handleProcessHtml}
                        disabled={htmlProcessing || !htmlInput.trim()}
                      >
                        {htmlProcessing ? <><Spinner size="sm" /> Processing…</> : 'Process HTML'}
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-xs">
                        <div className="font-semibold text-green-800 mb-1">Profile detected:</div>
                        <div className="text-green-700 space-y-0.5">
                          <div>Name: <strong>{htmlPreviewProfile.candidateName || '—'}</strong></div>
                          <div>Bios: {Object.values(htmlPreviewProfile.bios).filter(Boolean).length} found</div>
                          <div>Issues: {htmlPreviewProfile.issues.length} found</div>
                          <div>Sources: {htmlPreviewProfile.sources.length} found</div>
                        </div>
                      </div>
                      <div className="flex items-center justify-end gap-3">
                        <button
                          className="btn-secondary text-sm"
                          onClick={() => setHtmlPreviewProfile(null)}
                        >
                          Re-process
                        </button>
                        <button
                          className="btn-primary text-sm"
                          onClick={handleAddHtmlCandidate}
                        >
                          Add to Queue
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {deletingItem && (
        <ConfirmDialog
          title="Remove Candidate"
          message="Remove this candidate from the queue?"
          onConfirm={() => handleRemove(deletingItem)}
          onCancel={() => setDeletingItem(null)}
        />
      )}

      {/* Side panel */}
      {panelItem && (
        <CandidateSidePanel item={panelItem} onClose={() => setPanelItem(null)} />
      )}
    </div>
  );
}

/* ─── Queue Column Component ──────────────────────── */

interface QueueColumnProps {
  title: string;
  subtitle: string;
  columnId: ColumnId;
  items: BatchQueueItem[];
  dragOverColumn: ColumnId | null;
  onDragEnter: (e: React.DragEvent, column: ColumnId) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent, column: ColumnId) => void;
  onDrop: (e: React.DragEvent, column: ColumnId) => void;
  headerColor: string;
  headerActions?: React.ReactNode;
  emptyMessage?: string;
  renderItem: (item: BatchQueueItem) => React.ReactNode;
}

function QueueColumn({
  title, subtitle, columnId, items, dragOverColumn,
  onDragEnter, onDragOver, onDragLeave, onDrop,
  headerColor, headerActions, emptyMessage, renderItem,
}: QueueColumnProps) {
  const isOver = dragOverColumn === columnId;

  return (
    <div
      className={`flex flex-col rounded-xl border transition-all ${
        isOver ? 'border-branch-400 bg-branch-50/30 ring-2 ring-branch-200' : 'border-gray-200 bg-white'
      }`}
      onDragEnter={e => onDragEnter(e, columnId)}
      onDragOver={onDragOver}
      onDragLeave={e => onDragLeave(e, columnId)}
      onDrop={e => onDrop(e, columnId)}
    >
      {/* Column header */}
      <div className={`px-3 py-2.5 rounded-t-xl border-b flex items-center justify-between ${headerColor}`}>
        <div>
          <h3 className="text-xs font-bold text-gray-800">{title}</h3>
          <span className="text-[10px] text-gray-500">{subtitle}</span>
        </div>
        {headerActions}
      </div>

      {/* Column body */}
      <div className="flex-1 p-2 space-y-1.5 overflow-y-auto max-h-[60vh] min-h-[120px]">
        {items.length === 0 ? (
          <div className="flex items-center justify-center h-full min-h-[80px] text-xs text-gray-400 italic">
            {emptyMessage || 'No items'}
          </div>
        ) : (
          items.map(item => renderItem(item))
        )}
      </div>
    </div>
  );
}

/* ─── Candidate Card Component ────────────────────── */

interface CandidateCardProps {
  item: BatchQueueItem;
  draggable: boolean;
  onDragStart: (e: React.DragEvent, id: string) => void;
  onDragEnd: (e: React.DragEvent) => void;
  draggedId: string | null;
  onRemove: () => void;
  onClick?: () => void;
  actions?: React.ReactNode;
}

function CandidateCard({ item, draggable, onDragStart, onDragEnd, draggedId, onRemove, onClick, actions }: CandidateCardProps) {
  const isDragging = draggedId === item.id;
  const isHtml = Boolean(item.importedHtml);

  return (
    <div
      className={`group rounded-lg border px-2.5 py-2 transition-all ${
        draggable ? 'cursor-grab active:cursor-grabbing' : onClick ? 'cursor-pointer' : ''
      } ${
        isDragging
          ? 'opacity-40 border-branch-300 bg-branch-50'
          : 'border-gray-100 bg-white hover:border-gray-200 hover:shadow-sm'
      }`}
      draggable={draggable}
      onDragStart={e => draggable && onDragStart(e, item.id)}
      onDragEnd={onDragEnd}
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-1">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            {/* Drag handle indicator */}
            {draggable && (
              <svg className="h-3 w-3 text-gray-300 shrink-0" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
                <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
                <circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
              </svg>
            )}
            <span className="text-xs font-semibold text-gray-800 truncate">{item.candidateName}</span>
            {item.metadata.party && (
              <span className={`text-[9px] font-bold px-1 py-0.5 rounded ${PARTY_COLORS[item.metadata.party] || 'bg-gray-100 text-gray-700'}`}>
                {item.metadata.party}
              </span>
            )}
            {isHtml && (
              <span className="text-[9px] font-medium px-1 py-0.5 rounded bg-orange-100 text-orange-700">
                HTML
              </span>
            )}
          </div>
          <div className="text-[10px] text-gray-400 mt-0.5 truncate">
            {[item.metadata.officeName, item.metadata.districtName, item.metadata.state].filter(Boolean).join(' \u00b7 ')
              || (isHtml ? 'Imported from HTML' : '')}
          </div>
          {item.error && (
            <div className="text-[10px] text-red-500 mt-0.5 truncate">{item.error}</div>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {actions}
          <button
            className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 transition-all"
            onClick={e => { e.stopPropagation(); onRemove(); }}
            title="Remove"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Parsers ─────────────────────────────────────── */

function parseJson(content: string): ParsedCandidate[] {
  const raw = JSON.parse(content);
  const arr = Array.isArray(raw) ? raw : [raw];

  return arr.map((item: any, i: number) => {
    const name = item.name || item.candidateName || item.official || `Candidate ${i + 1}`;
    const metadata: CandidateMetadata = {
      election: item.election || item.electionKey,
      party: item.party,
      officeName: item.officeName || item.race?.officeName,
      officeKey: item.officeKey || item.race?.officeKey,
      districtType: item.districtType || item.race?.district?.type,
      districtName: item.districtName || item.race?.district?.name,
      state: item.state || item.race?.district?.state,
      raceKey: item.raceKey || item.race?.raceKey,
      issuesToCover: item.issuesToCover || item.race?.issuesToCover,
      priorityLevel: item.priorityLevel,
      incumbent: item.incumbent,
    };
    return { candidateName: name, metadata };
  });
}

function parseCsv(content: string): ParsedCandidate[] {
  const lines = content.trim().split('\n');
  if (lines.length < 2) throw new Error('CSV must have a header row and at least one data row');

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const nameIdx = headers.findIndex(h => h === 'name' || h === 'candidatename' || h === 'candidate_name');
  if (nameIdx === -1) throw new Error('CSV must have a "name" column');

  return lines.slice(1).filter(l => l.trim()).map(line => {
    const cols = line.split(',').map(c => c.trim());
    const get = (key: string) => {
      const idx = headers.indexOf(key);
      return idx >= 0 ? cols[idx] || undefined : undefined;
    };

    return {
      candidateName: cols[nameIdx] || 'Unknown',
      metadata: {
        election: get('election'),
        party: get('party'),
        officeName: get('officename') || get('office_name') || get('office'),
        districtType: get('districttype') || get('district_type'),
        districtName: get('districtname') || get('district_name') || get('district'),
        state: get('state'),
        raceKey: get('racekey') || get('race_key'),
        issuesToCover: get('issuestocover')?.split(';').map(s => s.trim()) || undefined,
        priorityLevel: get('priority') || get('prioritylevel'),
      },
    };
  });
}
