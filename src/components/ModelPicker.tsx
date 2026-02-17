import React, { useState, useRef, useEffect } from 'react';
import { AI_PROVIDERS, COST_TIER_LABELS, type AIProviderType, type ModelInfo } from '../types';

interface ModelPickerProps {
  providerType: AIProviderType;
  selectedModel?: string;
  onSelect: (modelId: string) => void;
  compact?: boolean;
}

/**
 * VS Code Copilot–style model picker dropdown.
 * Shows model name, cost tier badge, and context window.
 */
export function ModelPicker({ providerType, selectedModel, onSelect, compact }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const provider = AI_PROVIDERS[providerType];
  const models = provider.models;
  const current = models.find(m => m.id === selectedModel) || models[0];

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const tierInfo = COST_TIER_LABELS[current.costTier];

  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-2 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 transition-colors text-left
          ${compact ? 'px-2 py-1 text-xs' : 'px-3 py-2 text-sm'}`}
      >
        <span className="font-medium text-gray-800 truncate max-w-[180px]">{current.name}</span>
        <span className={`font-mono text-[10px] font-bold ${tierInfo.color}`}>{tierInfo.label}</span>
        <svg className={`h-3 w-3 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-80 bg-gray-900 rounded-xl shadow-2xl border border-gray-700 py-1 overflow-hidden"
          style={{ maxHeight: '400px', overflowY: 'auto' }}>

          {/* Free models section */}
          {models.some(m => m.costTier === '0x') && (
            <>
              <div className="px-3 py-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-wider">Free Tier</div>
              {models.filter(m => m.costTier === '0x').map(m => (
                <ModelRow key={m.id} model={m} selected={m.id === current.id} onSelect={() => { onSelect(m.id); setOpen(false); }} />
              ))}
            </>
          )}

          {/* Paid models section */}
          {models.some(m => m.costTier !== '0x') && (
            <>
              <div className="px-3 py-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-wider border-t border-gray-700 mt-1">Paid</div>
              {models.filter(m => m.costTier !== '0x').map(m => (
                <ModelRow key={m.id} model={m} selected={m.id === current.id} onSelect={() => { onSelect(m.id); setOpen(false); }} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ModelRow({ model, selected, onSelect }: { model: ModelInfo; selected: boolean; onSelect: () => void }) {
  const tier = COST_TIER_LABELS[model.costTier];
  return (
    <button
      onClick={onSelect}
      className={`w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-gray-800 transition-colors
        ${selected ? 'bg-gray-800' : ''}`}
    >
      <div className="flex items-center gap-2">
        {selected && <span className="text-blue-400">✓</span>}
        {!selected && <span className="w-4" />}
        <span className="text-gray-100 font-medium">{model.name}</span>
      </div>
      <div className="flex items-center gap-3">
        {model.supportsGrounding && (
          <span className="text-[9px] bg-green-900 text-green-300 px-1.5 py-0.5 rounded font-medium">GROUNDING</span>
        )}
        {model.contextWindow && (
          <span className="text-[10px] text-gray-500">{(model.contextWindow / 1000).toFixed(0)}K ctx</span>
        )}
        <span className={`font-mono text-xs font-bold ${tier.color}`}>{tier.label}</span>
      </div>
    </button>
  );
}

/**
 * Inline cost badge for showing in small spaces.
 */
export function CostBadge({ costTier }: { costTier: ModelInfo['costTier'] }) {
  const tier = COST_TIER_LABELS[costTier];
  return (
    <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-bold ${tier.color} ${
      costTier === '0x' ? 'bg-green-50' : costTier === '0.33x' ? 'bg-blue-50' : costTier === '1x' ? 'bg-yellow-50' : costTier === '3x' ? 'bg-orange-50' : 'bg-red-50'
    }`}>
      {tier.label}
    </span>
  );
}
