/**
 * WorkspacePage — the main 3-column workspace layout.
 * Replaces the old multi-page routing (Candidates, Build, Audit, History).
 *
 *  Col A: Queue (add & queue candidates)
 *  Col B: Processing (running pipeline)
 *  Col C: History (completed profiles)
 *
 * Clicking any candidate card opens the CandidateSidePanel.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import QueuePanel from '../components/workspace/QueuePanel';
import ProcessingPanel from '../components/workspace/ProcessingPanel';
import HistoryPanel from '../components/workspace/HistoryPanel';
import CandidateSidePanel from '../components/CandidateSidePanel';
import { ErrorBoundary } from '../components/ErrorBoundary';
import type { BatchQueueItem } from '../types';

const STORAGE_KEY = 'branch-playground-col-widths';
const MIN_COL = 200;
const DEFAULT_LEFT = 280;
const DEFAULT_RIGHT = 280;

function loadWidths(): [number, number] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) { const [l, r] = JSON.parse(raw); return [l || DEFAULT_LEFT, r || DEFAULT_RIGHT]; }
  } catch {}
  return [DEFAULT_LEFT, DEFAULT_RIGHT];
}

function ResizeHandle({ onDrag }: { onDrag: (delta: number) => void }) {
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const onMove = (ev: MouseEvent) => onDrag(ev.clientX - startX);
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); document.body.style.cursor = ''; document.body.style.userSelect = ''; };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [onDrag]);

  return (
    <div
      onMouseDown={handleMouseDown}
      className="w-1.5 shrink-0 cursor-col-resize bg-gray-200 hover:bg-branch-400 active:bg-branch-500 transition-colors relative group"
      title="Drag to resize"
    >
      <div className="absolute inset-y-0 -left-1 -right-1" />
    </div>
  );
}

export default function WorkspacePage() {
  const [panelItem, setPanelItem] = useState<BatchQueueItem | null>(null);
  const [[leftW, rightW], setWidths] = useState(loadWidths);
  const containerRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<[number, number]>([leftW, rightW]);

  // Persist widths
  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify([leftW, rightW])); }, [leftW, rightW]);

  const handleLeftDrag = useCallback((delta: number) => {
    setWidths(([, r]) => {
      const newLeft = Math.max(MIN_COL, baseRef.current[0] + delta);
      return [newLeft, r];
    });
  }, []);

  const handleRightDrag = useCallback((delta: number) => {
    setWidths(([l]) => {
      const newRight = Math.max(MIN_COL, baseRef.current[1] - delta);
      return [l, newRight];
    });
  }, []);

  // Update base ref on mousedown via the handle
  const onLeftStart = useCallback((delta: number) => {
    if (delta === 0) baseRef.current = [leftW, rightW]; // reset baseline at start
    handleLeftDrag(delta);
  }, [leftW, rightW, handleLeftDrag]);

  const onRightStart = useCallback((delta: number) => {
    if (delta === 0) baseRef.current = [leftW, rightW];
    handleRightDrag(delta);
  }, [leftW, rightW, handleRightDrag]);

  return (
    <div ref={containerRef} className="flex flex-1 min-h-0 overflow-hidden -mx-4 sm:-mx-6 lg:-mx-8">
      {/* 3-column grid with draggable dividers */}
      <div className="flex flex-1 min-w-0 overflow-hidden">
        {/* Column A — Queue */}
        <div style={{ width: leftW, minWidth: MIN_COL }} className="shrink-0 overflow-hidden flex flex-col border-r border-gray-200">
          <ErrorBoundary inline label="Queue">
            <QueuePanel onSelect={setPanelItem} />
          </ErrorBoundary>
        </div>

        <ResizeHandle onDrag={onLeftStart} />

        {/* Column B — Processing */}
        <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
          <ErrorBoundary inline label="Processing">
            <ProcessingPanel onSelect={setPanelItem} />
          </ErrorBoundary>
        </div>

        <ResizeHandle onDrag={onRightStart} />

        {/* Column C — History */}
        <div style={{ width: rightW, minWidth: MIN_COL }} className="shrink-0 overflow-hidden flex flex-col border-l border-gray-200">
          <ErrorBoundary inline label="History">
            <HistoryPanel onSelect={setPanelItem} />
          </ErrorBoundary>
        </div>
      </div>

      {/* Side panel — candidate detail */}
      {panelItem && (
        <CandidateSidePanel item={panelItem} onClose={() => setPanelItem(null)} />
      )}
    </div>
  );
}
