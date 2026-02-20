/**
 * UploadModal — "Add Candidates" dialog with CSV/JSON and HTML Import tabs.
 * Extracted from CandidatesPage. Handles duplicate detection before adding.
 */

import React, { useState, useRef, useCallback } from 'react';
import { useApp } from '../../context/AppContext';
import { extractBranchProfile } from '../../services/htmlExtractor';
import { Spinner } from '../shared';
import type {
  BatchQueueItem,
  BatchItemStatus,
  CandidateMetadata,
  ExtractedProfile,
} from '../../types';
import { v4 as uuid } from 'uuid';

/* ─── Types ───────────────────────────────────────── */

interface ParsedCandidate {
  candidateName: string;
  metadata: CandidateMetadata;
}

/** Compact key for deduplication: lowercase name + raceKey or officeName + election */
function dedupKey(name: string, meta: CandidateMetadata): string {
  const n = name.trim().toLowerCase();
  const race = (meta.raceKey || meta.officeName || '').toLowerCase();
  const election = (meta.election || '').toLowerCase();
  return `${n}::${race}::${election}`;
}

interface DuplicateResolution {
  key: string;
  incoming: BatchQueueItem;
  existing: BatchQueueItem;
  resolution: 'replace' | 'skip' | 'add-anyway' | null;
}

type AddTab = 'csv-json' | 'html';

export interface UploadModalProps {
  onClose: () => void;
}

/* ─── UploadModal Component ──────────────────────── */

export default function UploadModal({ onClose }: UploadModalProps) {
  const { batchQueue, addToQueue, setBatchQueue, sessions, showToast } = useApp();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const htmlFileInputRef = useRef<HTMLInputElement>(null);

  const [addTab, setAddTab] = useState<AddTab>('csv-json');
  const [rawInput, setRawInput] = useState('');
  const [inputFormat, setInputFormat] = useState<'json' | 'csv'>('json');
  const [parseError, setParseError] = useState<string | null>(null);

  // HTML import state
  const [htmlInput, setHtmlInput] = useState('');
  const [htmlCandidateName, setHtmlCandidateName] = useState('');
  const [htmlPreviewProfile, setHtmlPreviewProfile] = useState<ExtractedProfile | null>(null);
  const [htmlProcessing, setHtmlProcessing] = useState(false);

  // Duplicate dialog state
  const [pendingItems, setPendingItems] = useState<BatchQueueItem[]>([]);
  const [duplicates, setDuplicates] = useState<DuplicateResolution[]>([]);
  const [showDupDialog, setShowDupDialog] = useState(false);

  /* ─── Deduplication logic ───────────────────────── */
  const checkForDuplicates = useCallback(
    (items: BatchQueueItem[]): DuplicateResolution[] => {
      const existingKeys = new Map<string, BatchQueueItem>();

      // Check against current queue
      for (const qi of batchQueue) {
        existingKeys.set(dedupKey(qi.candidateName, qi.metadata || {}), qi);
      }
      // Check against sessions
      for (const s of sessions) {
        const syntheticMeta: CandidateMetadata = s.metadata || {};
        existingKeys.set(dedupKey(s.candidateName, syntheticMeta), {
          id: s.id,
          candidateName: s.candidateName,
          metadata: syntheticMeta,
          status: 'complete',
          sessionId: s.id,
        } as BatchQueueItem);
      }

      const result: DuplicateResolution[] = [];
      for (const item of items) {
        const key = dedupKey(item.candidateName, item.metadata || {});
        const existing = existingKeys.get(key);
        if (existing) {
          result.push({ key, incoming: item, existing, resolution: 'skip' });
        }
      }
      return result;
    },
    [batchQueue, sessions],
  );

  const finalizeAdd = useCallback(
    (items: BatchQueueItem[], dups: DuplicateResolution[]) => {
      // Start with all non-duplicate items
      const dupKeys = new Set(dups.map(d => dedupKey(d.incoming.candidateName, d.incoming.metadata || {})));
      const safeItems = items.filter(
        i => !dupKeys.has(dedupKey(i.candidateName, i.metadata || {})),
      );

      // Apply resolutions for duplicates
      const toRemove: string[] = [];
      for (const dup of dups) {
        if (dup.resolution === 'skip') continue;
        if (dup.resolution === 'replace') {
          // Remove old one from queue (not sessions)
          const old = batchQueue.find(qi => qi.id === dup.existing.id);
          if (old) toRemove.push(old.id);
          safeItems.push(dup.incoming);
        } else if (dup.resolution === 'add-anyway') {
          safeItems.push(dup.incoming);
        }
      }

      if (toRemove.length > 0) {
        setBatchQueue(prev => prev.filter(qi => !toRemove.includes(qi.id)));
      }

      if (safeItems.length > 0) {
        addToQueue(safeItems);
        showToast(`Added ${safeItems.length} candidate(s)`, 'success');
      } else {
        showToast('No candidates added', 'info');
      }

      setShowDupDialog(false);
      setPendingItems([]);
      setDuplicates([]);
      onClose();
    },
    [batchQueue, addToQueue, setBatchQueue, showToast, onClose],
  );

  const handleCandidates = useCallback(
    (candidates: ParsedCandidate[]) => {
      const items: BatchQueueItem[] = candidates.map(c => ({
        id: uuid(),
        candidateName: c.candidateName,
        metadata: c.metadata,
        status: 'queued' as BatchItemStatus,
      }));

      const dups = checkForDuplicates(items);
      if (dups.length > 0) {
        setPendingItems(items);
        setDuplicates(dups.map(d => ({ ...d, resolution: 'skip' })));
        setShowDupDialog(true);
      } else {
        finalizeAdd(items, []);
      }
    },
    [checkForDuplicates, finalizeAdd],
  );

  /* ─── CSV/JSON handlers ──────────────────────────── */
  const handleFileUpload = useCallback(
    (file: File) => {
      setParseError(null);
      const reader = new FileReader();
      reader.onload = e => {
        const content = e.target?.result as string;
        if (!content) return;
        try {
          const candidates = file.name.endsWith('.csv') ? parseCsv(content) : parseJson(content);
          handleCandidates(candidates);
        } catch (err: any) {
          setParseError(err.message);
        }
      };
      reader.readAsText(file);
    },
    [handleCandidates],
  );

  const handleParseInput = useCallback(() => {
    setParseError(null);
    try {
      const candidates = inputFormat === 'csv' ? parseCsv(rawInput) : parseJson(rawInput);
      handleCandidates(candidates);
    } catch (err: any) {
      setParseError(err.message);
    }
  }, [rawInput, inputFormat, handleCandidates]);

  /* ─── HTML handlers ──────────────────────────────── */
  const handleHtmlFileUpload = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = e => {
      const content = e.target?.result as string;
      if (content) {
        setHtmlInput(content);
        showToast(`Loaded ${file.name}`, 'success');
      }
    };
    reader.readAsText(file);
  }, [showToast]);

  const handleProcessHtml = useCallback(() => {
    if (!htmlInput.trim()) { showToast('Paste HTML or upload a file first', 'error'); return; }
    setHtmlProcessing(true);
    try {
      const profile = extractBranchProfile(htmlInput);
      setHtmlPreviewProfile(profile);
      if (profile.candidateName && !htmlCandidateName) setHtmlCandidateName(profile.candidateName);
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
      extractedProfile: htmlPreviewProfile ?? undefined,
    };
    const dups = checkForDuplicates([item]);
    if (dups.length > 0) {
      setPendingItems([item]);
      setDuplicates(dups.map(d => ({ ...d, resolution: 'skip' })));
      setShowDupDialog(true);
    } else {
      finalizeAdd([item], []);
    }
  }, [htmlCandidateName, htmlInput, htmlPreviewProfile, checkForDuplicates, finalizeAdd]);

  /* ─── Render ────────────────────────────────────── */

  if (showDupDialog) {
    return (
      <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setShowDupDialog(false)}>
        <div className="bg-white rounded-2xl shadow-2xl max-w-xl w-full max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
          <div className="p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-gray-900">Duplicate Candidates</h3>
              <button className="text-gray-400 hover:text-gray-600" onClick={() => setShowDupDialog(false)}>
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <p className="text-sm text-gray-500">
              {duplicates.length} candidate{duplicates.length !== 1 ? 's' : ''} already exist{duplicates.length === 1 ? 's' : ''} in the queue or history. Choose what to do with each:
            </p>

            <div className="space-y-3">
              {duplicates.map((dup, i) => (
                <div key={dup.key} className="border border-gray-200 rounded-lg p-3 space-y-2">
                  <div className="text-sm font-semibold text-gray-800">{dup.incoming.candidateName}</div>
                  {dup.incoming.metadata?.officeName && (
                    <div className="text-xs text-gray-400">{dup.incoming.metadata.officeName}{dup.incoming.metadata?.election ? ` · ${dup.incoming.metadata.election}` : ''}</div>
                  )}
                  <div className="text-xs text-orange-600 bg-orange-50 rounded px-2 py-1">
                    ⚠ Matches existing: <strong>{dup.existing.candidateName}</strong> ({dup.existing.status})
                  </div>
                  <div className="flex items-center gap-2">
                    {(['replace', 'skip', 'add-anyway'] as const).map(opt => (
                      <button
                        key={opt}
                        onClick={() => setDuplicates(prev => prev.map((d, j) => j === i ? { ...d, resolution: opt } : d))}
                        className={`flex-1 text-xs py-1.5 rounded-lg font-medium border transition-colors ${
                          dup.resolution === opt
                            ? opt === 'skip' ? 'bg-gray-800 text-white border-gray-800'
                              : opt === 'replace' ? 'bg-red-600 text-white border-red-600'
                              : 'bg-branch-600 text-white border-branch-600'
                            : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        {opt === 'replace' ? 'Replace' : opt === 'skip' ? 'Skip' : 'Add Anyway'}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-2 pt-2 border-t border-gray-100">
              <button className="btn-secondary text-sm flex-1" onClick={() => setShowDupDialog(false)}>Cancel</button>
              <button
                className="btn-primary text-sm flex-1"
                disabled={duplicates.some(d => d.resolution === null)}
                onClick={() => finalizeAdd(pendingItems, duplicates)}
              >
                Continue ({duplicates.filter(d => d.resolution !== 'skip').length} will be added)
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="p-6 space-y-4">
          {/* Header */}
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-bold text-gray-900">Add Candidates</h3>
            <button className="text-gray-400 hover:text-gray-600" onClick={onClose}>
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Tab bar */}
          <div className="flex rounded-lg overflow-hidden border border-gray-200">
            {(['csv-json', 'html'] as AddTab[]).map(tab => (
              <button
                key={tab}
                className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
                  addTab === tab ? 'bg-branch-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
                onClick={() => setAddTab(tab)}
              >
                {tab === 'csv-json' ? 'CSV / JSON' : 'HTML Import'}
              </button>
            ))}
          </div>

          {/* ─── CSV/JSON Tab ─────────────────────── */}
          {addTab === 'csv-json' && (
            <div className="space-y-4">
              {/* File drop zone */}
              <div
                className="border-2 border-dashed border-gray-200 rounded-xl p-8 text-center hover:border-branch-300 cursor-pointer transition-colors group"
                onClick={() => fileInputRef.current?.click()}
                onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
                onDrop={e => { e.preventDefault(); e.stopPropagation(); const f = e.dataTransfer.files[0]; if (f) handleFileUpload(f); }}
              >
                <input ref={fileInputRef} type="file" accept=".json,.csv" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleFileUpload(f); e.target.value = ''; }} />
                <svg className="mx-auto h-10 w-10 text-gray-300 group-hover:text-branch-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
                <p className="mt-3 text-sm font-medium text-gray-600">
                  Drop a file or <span className="text-branch-600">click to browse</span>
                </p>
                <p className="mt-1 text-xs text-gray-400">Accepts .json or .csv</p>
              </div>

              <div className="flex items-center gap-3">
                <div className="flex-1 border-t border-gray-200" />
                <span className="text-xs text-gray-400 font-medium">OR PASTE DATA</span>
                <div className="flex-1 border-t border-gray-200" />
              </div>

              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-500 font-medium">Format:</label>
                <div className="flex rounded-lg overflow-hidden border border-gray-200">
                  {(['json', 'csv'] as const).map(f => (
                    <button
                      key={f}
                      className={`px-3 py-1 text-xs font-medium ${inputFormat === f ? 'bg-branch-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                      onClick={() => setInputFormat(f)}
                    >
                      {f.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>

              <textarea
                className="w-full border border-gray-200 rounded-lg p-3 font-mono text-xs resize-none focus:ring-2 focus:ring-branch-500 focus:border-branch-500"
                rows={10}
                placeholder={inputFormat === 'json'
                  ? '[\n  {\n    "name": "Jane Smith",\n    "party": "D",\n    "state": "TX",\n    "officeName": "State Representative",\n    "election": "2026-texas-primary"\n  }\n]'
                  : 'name,party,state,officeName,election\nJane Smith,D,TX,State Representative,2026-texas-primary'
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

              <details className="text-xs">
                <summary className="font-semibold text-gray-600 cursor-pointer hover:text-gray-800">Expected Fields</summary>
                <div className="grid grid-cols-3 gap-1.5 mt-2">
                  {[['name', 'Required'], ['party', 'D/R/I/L/G'], ['state', '2-letter'], ['officeName', 'Title'], ['districtName', 'e.g. District 50'], ['election', 'e.g. 2026-tx-primary'], ['raceKey', 'Branch race key'], ['issuesToCover', 'Semicolon-sep.'], ['incumbent', 'true/false']].map(([f, d]) => (
                    <div key={f} className="bg-gray-50 rounded px-2 py-1">
                      <span className="font-mono text-gray-700">{f}</span>
                      <span className="text-gray-400 ml-1 text-xs">{d}</span>
                    </div>
                  ))}
                </div>
              </details>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button className="btn-secondary text-sm" onClick={onClose}>Cancel</button>
                <button className="btn-primary text-sm" onClick={handleParseInput} disabled={!rawInput.trim()}>
                  Add to Queue
                </button>
              </div>
            </div>
          )}

          {/* ─── HTML Import Tab ──────────────────── */}
          {addTab === 'html' && (
            <div className="space-y-4">
              <p className="text-xs text-gray-500">
                Import an existing candidate profile from HTML. This candidate will go directly to fact-checking since they already have profile data.
              </p>

              <div>
                <label className="text-xs font-medium text-gray-600">Candidate Name</label>
                <input
                  className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-branch-500 focus:border-branch-500"
                  placeholder="e.g., Jane Smith"
                  value={htmlCandidateName}
                  onChange={e => setHtmlCandidateName(e.target.value)}
                />
              </div>

              <div
                className="border-2 border-dashed border-gray-200 rounded-xl p-6 text-center hover:border-branch-300 cursor-pointer transition-colors group"
                onClick={() => htmlFileInputRef.current?.click()}
                onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
                onDrop={e => { e.preventDefault(); e.stopPropagation(); const f = e.dataTransfer.files[0]; if (f) handleHtmlFileUpload(f); }}
              >
                <input ref={htmlFileInputRef} type="file" accept=".html,.htm,.txt,.mhtml" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleHtmlFileUpload(f); e.target.value = ''; }} />
                <svg className="mx-auto h-8 w-8 text-gray-300 group-hover:text-branch-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
                <p className="mt-2 text-sm font-medium text-gray-600">
                  Drop an HTML file or <span className="text-branch-600">click to browse</span>
                </p>
              </div>

              <div className="flex items-center gap-3">
                <div className="flex-1 border-t border-gray-200" />
                <span className="text-xs text-gray-400 font-medium">OR PASTE HTML</span>
                <div className="flex-1 border-t border-gray-200" />
              </div>

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
                  if (content) { e.preventDefault(); setHtmlInput(content); }
                }}
              />
              {htmlInput && (
                <div className="text-xs text-gray-400">{(htmlInput.length / 1024).toFixed(1)} KB loaded</div>
              )}

              {!htmlPreviewProfile ? (
                <div className="flex items-center justify-end gap-3 pt-2">
                  <button className="btn-secondary text-sm" onClick={onClose}>Cancel</button>
                  <button className="btn-primary text-sm" onClick={handleProcessHtml} disabled={htmlProcessing || !htmlInput.trim()}>
                    {htmlProcessing ? <><Spinner size="sm" />Processing…</> : 'Process HTML'}
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
                    <button className="btn-secondary text-sm" onClick={() => setHtmlPreviewProfile(null)}>Re-process</button>
                    <button className="btn-primary text-sm" onClick={handleAddHtmlCandidate}>Add to Queue</button>
                  </div>
                </div>
              )}
            </div>
          )}
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
    return {
      candidateName: name,
      metadata: {
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
      },
    };
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
    const get = (key: string) => { const idx = headers.indexOf(key); return idx >= 0 ? cols[idx] || undefined : undefined; };
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
        issuesToCover: get('issuestocover')?.split(';').map((s: string) => s.trim()),
        priorityLevel: get('priority') || get('prioritylevel'),
      },
    };
  });
}
