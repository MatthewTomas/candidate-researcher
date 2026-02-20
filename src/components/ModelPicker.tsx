import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { AI_PROVIDERS, COST_TIER_LABELS, type AIProviderType, type ModelInfo } from '../types';
import { useApp } from '../context/AppContext';

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function formatCtx(ctx: number | undefined): string {
  if (!ctx) return '';
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(0)}M`;
  return `${(ctx / 1_000).toFixed(0)}K`;
}

/** Short provider label for the trigger button */
function providerLabel(type: AIProviderType): string {
  if (type === 'gemini-free' || type === 'gemini-paid') return 'Gemini';
  if (type === 'xai') return 'xAI';
  if (type === 'huggingface') return 'HuggingFace';
  if (type === 'openai') return 'OpenAI';
  if (type === 'anthropic') return 'Anthropic';
  if (type === 'qwen') return 'Qwen';
  if (type === 'deepseek') return 'DeepSeek';
  if (type === 'minimax') return 'MiniMax';
  return (AI_PROVIDERS as any)[type]?.name ?? type;
}

// Build a list of provider groups, merging gemini-free/paid into one
type ProviderGroup = {
  key: string;
  label: string;
  models: (ModelInfo & { providerType: AIProviderType })[];
};

function buildProviderGroups(geminiTier: string): ProviderGroup[] {
  const groups: ProviderGroup[] = [];

  // Gemini — single merged group
  const isFreeTier = !geminiTier || geminiTier === 'free';
  const geminiType: AIProviderType = isFreeTier ? 'gemini-free' : 'gemini-paid';
  const geminiConfig = AI_PROVIDERS[geminiType];
  groups.push({
    key: 'gemini',
    label: `Google Gemini${isFreeTier ? ' (Free Tier)' : ' (Paid)'}`,
    models: geminiConfig.models
      .filter(m => !m.deprecated)
      .map(m => ({ ...m, providerType: geminiType })),
  });

  const otherTypes: AIProviderType[] = ['xai', 'openai', 'anthropic', 'qwen', 'deepseek', 'minimax', 'huggingface'];
  for (const t of otherTypes) {
    const cfg = AI_PROVIDERS[t];
    if (!cfg) continue;
    groups.push({
      key: t,
      label: cfg.name,
      models: cfg.models
        .filter(m => !m.deprecated)
        .map(m => ({ ...m, providerType: t })),
    });
  }
  return groups;
}

// ────────────────────────────────────────────────────────────
// Unified Model Picker (provider + model + pricing in one)
// ────────────────────────────────────────────────────────────

interface UnifiedModelPickerProps {
  /** Current provider type (may be gemini-free — will be resolved) */
  providerType: AIProviderType;
  selectedModel?: string;
  /** Fires with (providerType, modelId) when user picks a model */
  onSelect: (provider: AIProviderType, modelId: string) => void;
  compact?: boolean;
}

export function ModelPicker({ providerType, selectedModel, onSelect, compact }: UnifiedModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [dropUp, setDropUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const { settings } = useApp();
  const geminiTier = settings.geminiTier || 'free';

  // Resolve gemini-free → gemini-paid when on a paid tier
  const resolvedProvider: AIProviderType =
    providerType === 'gemini-free' && geminiTier !== 'free'
      ? 'gemini-paid'
      : providerType;

  const resolvedConfig = AI_PROVIDERS[resolvedProvider];
  const current = resolvedConfig.models.find(m => m.id === selectedModel)
    || resolvedConfig.models.find(m => !m.deprecated)
    || resolvedConfig.models[0];

  const groups = useMemo(() => buildProviderGroups(geminiTier), [geminiTier]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setSearch(''); }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Focus search on open + measure drop direction
  useEffect(() => {
    if (open) {
      setTimeout(() => searchRef.current?.focus(), 50);
      // Decide if dropdown should open upward
      if (ref.current) {
        const rect = ref.current.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        setDropUp(spaceBelow < 360);
      }
    }
  }, [open]);

  const handleSelect = useCallback((provider: AIProviderType, modelId: string) => {
    onSelect(provider, modelId);
    setOpen(false);
    setSearch('');
  }, [onSelect]);

  // Filter models by search
  const filteredGroups = useMemo(() => {
    if (!search.trim()) return groups;
    const q = search.toLowerCase();
    return groups
      .map(g => ({
        ...g,
        models: g.models.filter(m =>
          m.name.toLowerCase().includes(q) ||
          g.label.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q)
        ),
      }))
      .filter(g => g.models.length > 0);
  }, [groups, search]);

  // Pricing display for the trigger
  const hasPrice = current.costPerMillionTokens !== undefined && current.costPerMillionTokens > 0;
  const tierInfo = COST_TIER_LABELS[current.costTier];

  return (
    <div ref={ref} className="relative">
      {/* ── Trigger Button ── */}
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 transition-colors text-left w-full
          ${compact ? 'px-2 py-1.5' : 'px-3 py-2'}`}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`font-medium text-gray-800 truncate ${compact ? 'text-xs' : 'text-sm'}`}>
              {current.name}
            </span>
            <span className={`shrink-0 font-mono text-[10px] font-bold px-1 py-0.5 rounded ${
              current.costTier === '0x' ? 'bg-green-100 text-green-700'
              : current.costTier === '0.33x' ? 'bg-blue-100 text-blue-700'
              : current.costTier === '1x' ? 'bg-yellow-100 text-yellow-700'
              : current.costTier === '3x' ? 'bg-orange-100 text-orange-700'
              : 'bg-red-100 text-red-700'
            }`}>
              {tierInfo.label}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-gray-400">{providerLabel(resolvedProvider)}</span>
            {hasPrice ? (
              <span className="text-[10px] text-gray-500">
                ${current.costPerMillionTokens!.toFixed(2)} / ${(current.outputCostPerMillionTokens ?? current.costPerMillionTokens! * 3).toFixed(2)} per 1M
              </span>
            ) : (
              <span className="text-[10px] text-green-600 font-medium">Free</span>
            )}
          </div>
        </div>
        <svg className={`h-3 w-3 text-gray-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* ── Dropdown ── */}
      {open && (
        <div
          className={`absolute z-[100] w-[420px] max-w-[calc(100vw-2rem)] bg-gray-900 rounded-xl shadow-2xl border border-gray-700 overflow-hidden ${
            dropUp ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}
          style={{ maxHeight: '480px' }}
        >
          {/* Search */}
          <div className="px-3 pt-2 pb-1">
            <input
              ref={searchRef}
              type="text"
              placeholder="Search models…"
              className="w-full bg-gray-800 text-gray-200 text-xs rounded-lg px-3 py-1.5 border border-gray-700 outline-none focus:border-blue-500 placeholder:text-gray-500"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          {/* Model list */}
          <div className="overflow-y-auto" style={{ maxHeight: '420px' }}>
            {filteredGroups.length === 0 && (
              <div className="px-3 py-4 text-center text-gray-500 text-xs">No models match &ldquo;{search}&rdquo;</div>
            )}
            {filteredGroups.map(group => (
              <div key={group.key}>
                {/* Provider header */}
                <div className="sticky top-0 z-10 bg-gray-800/95 backdrop-blur px-3 py-1.5 border-t border-gray-700 first:border-t-0">
                  <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">{group.label}</span>
                </div>

                {/* Models */}
                {group.models.map(model => {
                  const isSelected = model.id === current.id && model.providerType === resolvedProvider;
                  const hasModelPrice = model.costPerMillionTokens !== undefined && model.costPerMillionTokens > 0;
                  const mTier = COST_TIER_LABELS[model.costTier];

                  return (
                    <button
                      key={`${model.providerType}-${model.id}`}
                      onClick={() => handleSelect(model.providerType, model.id)}
                      className={`w-full text-left px-3 py-2 hover:bg-gray-800 transition-colors flex items-start gap-2
                        ${isSelected ? 'bg-gray-800 border-l-2 border-blue-400' : 'border-l-2 border-transparent'}`}
                    >
                      {/* Selection check */}
                      <span className="w-4 shrink-0 mt-0.5">
                        {isSelected && <span className="text-blue-400 text-sm">✓</span>}
                      </span>

                      {/* Model info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-gray-100 text-sm font-medium truncate">{model.name}</span>
                          {model.reasoning && (
                            <span className="text-[9px] bg-purple-900 text-purple-300 px-1 py-0.5 rounded font-medium shrink-0">REASON</span>
                          )}
                          {model.supportsGrounding && (
                            <span className="text-[9px] bg-green-900 text-green-300 px-1 py-0.5 rounded font-medium shrink-0">GROUND</span>
                          )}
                        </div>
                        {model.contextWindow && (
                          <span className="text-[10px] text-gray-500 mt-0.5 block">{formatCtx(model.contextWindow)} context</span>
                        )}
                      </div>

                      {/* Pricing */}
                      <div className="text-right shrink-0">
                        <span className={`font-mono text-[10px] font-bold px-1.5 py-0.5 rounded ${
                          model.costTier === '0x' ? 'bg-green-900/50 text-green-400'
                          : model.costTier === '0.33x' ? 'bg-blue-900/50 text-blue-400'
                          : model.costTier === '1x' ? 'bg-yellow-900/50 text-yellow-400'
                          : model.costTier === '3x' ? 'bg-orange-900/50 text-orange-400'
                          : 'bg-red-900/50 text-red-400'
                        }`}>
                          {mTier.label}
                        </span>
                        {hasModelPrice ? (
                          <div className="text-[10px] text-gray-500 mt-0.5 whitespace-nowrap">
                            <span className="text-gray-400">${model.costPerMillionTokens!.toFixed(2)}</span>
                            <span className="text-gray-600 mx-0.5">/</span>
                            <span className="text-gray-400">${(model.outputCostPerMillionTokens ?? model.costPerMillionTokens! * 3).toFixed(2)}</span>
                            <span className="text-gray-600 ml-0.5">1M</span>
                          </div>
                        ) : (
                          <div className="text-[10px] text-green-500 mt-0.5">$0</div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Footer legend */}
          <div className="px-3 py-1.5 border-t border-gray-700 bg-gray-800/80 text-[10px] text-gray-500 flex items-center gap-3">
            <span>Pricing: <strong className="text-gray-400">input / output</strong> per 1M tokens</span>
            <span className="ml-auto">{groups.reduce((s, g) => s + g.models.length, 0)} models</span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Inline cost badge for showing in small spaces.
 */
export function CostBadge({ costTier }: { costTier: ModelInfo['costTier'] }) {
  const tier = COST_TIER_LABELS[costTier];
  return (
    <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-xs font-bold ${tier.color} ${
      costTier === '0x' ? 'bg-green-50' : costTier === '0.33x' ? 'bg-blue-50' : costTier === '1x' ? 'bg-yellow-50' : costTier === '3x' ? 'bg-orange-50' : 'bg-red-50'
    }`}>
      {tier.label}
    </span>
  );
}
