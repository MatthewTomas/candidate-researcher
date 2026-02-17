// ============================================================================
// Branch JSON Schema Types — matches the stagingDraft structure from Branch API
// ============================================================================

// --- Source & Citation Types ---

export interface Source {
  sourceType: 'website' | 'other' | 'questionnaire' | 'social' | 'news';
  directQuote: string;
  url: string;
  title?: string;
  _id?: string;
  /** Whether the source URL is behind a paywall */
  paywalled?: boolean;
}

export interface ReferenceCategory {
  type: 'website' | 'social' | 'official-website' | 'questionnaire' | 'news' | 'other';
  sources: LinkItem[];
  missing: boolean;
  _id?: string;
}

export interface References {
  checked: boolean;
  totalSources: number;
  categories: ReferenceCategory[];
  _id?: string;
}

// --- Link Types ---

export interface LinkItem {
  mediaType: 'website' | 'facebook' | 'twitter' | 'instagram' | 'linkedin' | 'youtube' | 'tiktok' | 'other';
  url: string;
  title?: string;
  _id?: string;
  /** official / campaign / personal account classification */
  accountType?: 'official' | 'campaign' | 'personal';
  /** Confidence in correctness: high = verified, medium = third-party sourced, low = unconfirmed */
  confidence?: 'high' | 'medium' | 'low';
}

// --- Bio Types ---

export interface AutoSummary {
  isAutoSummary: boolean;
  text: string | null;
  sources: Source[];
  issue?: string;
  addedByAutoSummary?: boolean;
  summaryGeneratedBySummarizer?: boolean;
}

export interface Bio {
  type: 'personal' | 'professional' | 'political';
  text: string;
  sources: Source[];
  complete: boolean;
  missingData?: string;
  /** Source verification status — set by provenance/URL checks */
  sourceVerified?: 'verified' | 'unverifiable' | 'fabricated' | 'not-in-input';
  autoSummary?: AutoSummary;
  _id?: string;
}

// --- Issue / Stance Types ---

export type StanceCategoryKey =
  | 'economy' | 'public-safety' | 'healthcare' | 'education'
  | 'environment' | 'immigration' | 'housing' | 'transportation'
  | 'gun-policy' | 'abortion' | 'civil-rights' | 'foreign-policy'
  | 'technology' | 'agriculture' | 'veterans' | 'criminal-justice'
  | 'consumer-protection' | 'government-reform' | 'labor'
  | 'social-services' | 'infrastructure' | 'legal-experience'
  | 'candidates-background';

export interface Stance {
  text: string;
  sources: Source[];
  complete: boolean;
  directQuote?: string;
  /** Source verification status — set by provenance/URL checks */
  sourceVerified?: 'verified' | 'unverifiable' | 'fabricated' | 'not-in-input';
  issuesSecondary: string[];
  textApproved: boolean;
  editsMade: boolean;
  autoSummary?: AutoSummary;
  _id?: string;
}

export interface Issue {
  key: StanceCategoryKey | string;
  title: string;
  complete: boolean;
  missingData?: string;
  stances: Stance[];
  text?: string;
  textArray: string[];
  sources: Source[];
  isTopPriority: boolean;
  policyTerms: string[];
  _id?: string;
}

// --- Candidate Profile (stagingDraft shape) ---

export interface StagingDraft {
  name: string;
  links: LinkItem[];
  bios: Bio[];
  issues: Issue[];
  archivedIssues: Issue[];
  progress: number;
  status: 'incomplete' | 'complete' | 'needs-review';
  incompleteFields: string[];
  profiledAt?: string;
  references: References;
  synced: boolean;
  version: number;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// AI Provider Types
// ============================================================================

export type AIProviderType = 'gemini-free' | 'gemini-paid' | 'xai' | 'huggingface' | 'openai' | 'anthropic' | 'qwen' | 'deepseek' | 'minimax';

export interface ModelInfo {
  id: string;
  name: string;
  costTier: '0x' | '0.33x' | '1x' | '3x' | '5x';
  costPerMillionTokens?: number; // input cost in USD per 1M tokens
  outputCostPerMillionTokens?: number; // output cost in USD per 1M tokens
  contextWindow?: number;
  supportsGrounding?: boolean;
  supportsJson?: boolean;
  deprecated?: boolean;
  reasoning?: boolean;
}

export interface AIProviderConfig {
  type: AIProviderType;
  name: string;
  description: string;
  requiresApiKey: boolean;
  isFree: boolean;
  supportsGrounding: boolean;
  defaultModel: string;
  models: ModelInfo[];
  apiKeyHelpUrl: string;
  apiKeyNote?: string; // safety information
}

export const AI_PROVIDERS: Record<AIProviderType, AIProviderConfig> = {
  // ─── Google Gemini (Free Tier) ─────────────────────────────
  // Source: https://ai.google.dev/gemini-api/docs/pricing (checked 2026-02-16)
  // Free tier = $0 input/output, rate-limited, data used to improve Google products.
  // Gemini 3 Pro Preview is NOT available on free tier.
  'gemini-free': {
    type: 'gemini-free',
    name: 'Gemini (Free)',
    description: 'Google AI Studio free tier — $0 but rate-limited. Gemini 3 Flash, 2.5 Pro, 2.5 Flash, 2.5 Flash-Lite. Data used to improve Google products.',
    requiresApiKey: true,
    isFree: true,
    supportsGrounding: false,
    defaultModel: 'gemini-3-flash-preview',
    apiKeyHelpUrl: 'https://aistudio.google.com/apikey',
    apiKeyNote: 'Uses Google AI Studio key. Same key as Gemini Paid. Free tier: $0 but data may be used to improve Google products. No billing needed.',
    models: [
      { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash (Preview)', costTier: '0x', contextWindow: 1048576, supportsJson: true },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', costTier: '0x', contextWindow: 1048576, supportsJson: true },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', costTier: '0x', contextWindow: 1048576, supportsJson: true },
      { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite', costTier: '0x', contextWindow: 1048576, supportsJson: true },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash (Deprecated Mar 2026)', costTier: '0x', contextWindow: 1048576, supportsJson: true, deprecated: true },
    ],
  },
  // ─── Google Gemini (Paid) ──────────────────────────────────
  // Source: https://ai.google.dev/gemini-api/docs/pricing (checked 2026-02-16)
  // Paid tier: per-token pricing, higher rate limits, data NOT used to improve products.
  // Gemini 3 Pro Preview is ONLY available on paid tier.
  'gemini-paid': {
    type: 'gemini-paid',
    name: 'Gemini (Paid)',
    description: 'Full Gemini lineup with Search Grounding. Gemini 3 Pro ($2/$12), 3 Flash ($0.50/$3), 2.5 Pro ($1.25/$10), 2.5 Flash ($0.30/$2.50).',
    requiresApiKey: true,
    isFree: false,
    supportsGrounding: true,
    defaultModel: 'gemini-2.5-flash',
    apiKeyHelpUrl: 'https://aistudio.google.com/apikey',
    apiKeyNote: 'Same Google AI Studio key as free tier. Bills to Google Cloud. Enable billing at console.cloud.google.com. Data NOT used to improve products.',
    models: [
      { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro (Preview)', costTier: '1x', costPerMillionTokens: 2.00, outputCostPerMillionTokens: 12.00, contextWindow: 1048576, supportsGrounding: true, supportsJson: true },
      { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash (Preview)', costTier: '0.33x', costPerMillionTokens: 0.50, outputCostPerMillionTokens: 3.00, contextWindow: 1048576, supportsGrounding: true, supportsJson: true },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', costTier: '1x', costPerMillionTokens: 1.25, outputCostPerMillionTokens: 10.00, contextWindow: 1048576, supportsGrounding: true, supportsJson: true },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', costTier: '0.33x', costPerMillionTokens: 0.30, outputCostPerMillionTokens: 2.50, contextWindow: 1048576, supportsGrounding: true, supportsJson: true },
      { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite', costTier: '0.33x', costPerMillionTokens: 0.10, outputCostPerMillionTokens: 0.40, contextWindow: 1048576, supportsGrounding: true, supportsJson: true },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash (Deprecated Mar 2026)', costTier: '0.33x', costPerMillionTokens: 0.10, outputCostPerMillionTokens: 0.40, contextWindow: 1048576, supportsGrounding: true, supportsJson: true, deprecated: true },
    ],
  },
  // ─── xAI (Grok) ────────────────────────────────────────────
  // Source: https://docs.x.ai/developers/models (checked 2026-02-17)
  // Supports web/X search tools, but tool invocations are billed separately.
  'xai': {
    type: 'xai',
    name: 'xAI (Grok)',
    description: 'Grok family models via xAI API. Strong reasoning and tool use. Paid usage with per-token pricing.',
    requiresApiKey: true,
    isFree: false,
    supportsGrounding: false,
    defaultModel: 'grok-4-1-fast-non-reasoning',
    apiKeyHelpUrl: 'https://console.x.ai/',
    apiKeyNote: 'xAI is paid usage. Search tools are billed separately per invocation in addition to tokens.',
    models: [
      { id: 'grok-4-1-fast-non-reasoning', name: 'Grok 4.1 Fast', costTier: '0.33x', costPerMillionTokens: 0.20, outputCostPerMillionTokens: 0.50, contextWindow: 2000000, supportsJson: true },
      { id: 'grok-3-mini', name: 'Grok 3 Mini', costTier: '0.33x', costPerMillionTokens: 0.30, outputCostPerMillionTokens: 0.50, contextWindow: 131072, supportsJson: true, reasoning: true },
      { id: 'grok-4-0709', name: 'Grok 4', costTier: '3x', costPerMillionTokens: 3.00, outputCostPerMillionTokens: 15.00, contextWindow: 256000, supportsJson: true, reasoning: true },
    ],
  },
  // ─── HuggingFace (Free) ────────────────────────────────────
  'huggingface': {
    type: 'huggingface',
    name: 'HuggingFace (Free)',
    description: 'HuggingFace Inference API — free with rate limits.',
    requiresApiKey: true,
    isFree: true,
    supportsGrounding: false,
    defaultModel: 'mistralai/Mistral-7B-Instruct-v0.3',
    apiKeyHelpUrl: 'https://huggingface.co/settings/tokens',
    apiKeyNote: 'HuggingFace access tokens are free. Free-tier inference has rate limits but no charges.',
    models: [
      { id: 'mistralai/Mistral-7B-Instruct-v0.3', name: 'Mistral 7B Instruct', costTier: '0x', contextWindow: 32768 },
      { id: 'meta-llama/Llama-3.2-3B-Instruct', name: 'Llama 3.2 3B', costTier: '0x', contextWindow: 8192 },
      { id: 'microsoft/Phi-3-mini-4k-instruct', name: 'Phi-3 Mini', costTier: '0x', contextWindow: 4096 },
    ],
  },
  // ─── OpenAI (Paid) ─────────────────────────────────────────
  'openai': {
    type: 'openai',
    name: 'OpenAI (Paid)',
    description: 'GPT-5 series, GPT-4.1, GPT-4o, o-series reasoning models.',
    requiresApiKey: true,
    isFree: false,
    supportsGrounding: false,
    defaultModel: 'gpt-4o',
    apiKeyHelpUrl: 'https://platform.openai.com/api-keys',
    apiKeyNote: 'OpenAI charges per token. Set a hard spending limit at platform.openai.com/settings/organization/limits.',
    models: [
      { id: 'gpt-5.2', name: 'GPT-5.2', costTier: '1x', costPerMillionTokens: 1.75, outputCostPerMillionTokens: 14.00, contextWindow: 128000, supportsJson: true },
      { id: 'gpt-5.1', name: 'GPT-5.1', costTier: '1x', costPerMillionTokens: 1.25, outputCostPerMillionTokens: 10.00, contextWindow: 128000, supportsJson: true },
      { id: 'gpt-5', name: 'GPT-5', costTier: '1x', costPerMillionTokens: 1.25, outputCostPerMillionTokens: 10.00, contextWindow: 128000, supportsJson: true },
      { id: 'gpt-5-mini', name: 'GPT-5 Mini', costTier: '0.33x', costPerMillionTokens: 0.25, outputCostPerMillionTokens: 2.00, contextWindow: 128000, supportsJson: true },
      { id: 'gpt-5-nano', name: 'GPT-5 Nano', costTier: '0x', costPerMillionTokens: 0.05, outputCostPerMillionTokens: 0.40, contextWindow: 128000, supportsJson: true },
      { id: 'gpt-4.1', name: 'GPT-4.1', costTier: '1x', costPerMillionTokens: 2.00, outputCostPerMillionTokens: 8.00, contextWindow: 1048576, supportsJson: true },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', costTier: '0.33x', costPerMillionTokens: 0.40, outputCostPerMillionTokens: 1.60, contextWindow: 1048576, supportsJson: true },
      { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano', costTier: '0.33x', costPerMillionTokens: 0.10, outputCostPerMillionTokens: 0.40, contextWindow: 1048576, supportsJson: true },
      { id: 'gpt-4o', name: 'GPT-4o', costTier: '1x', costPerMillionTokens: 2.50, outputCostPerMillionTokens: 10.00, contextWindow: 128000, supportsJson: true },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', costTier: '0.33x', costPerMillionTokens: 0.15, outputCostPerMillionTokens: 0.60, contextWindow: 128000, supportsJson: true },
      { id: 'o4-mini', name: 'o4-mini (Reasoning)', costTier: '1x', costPerMillionTokens: 1.10, outputCostPerMillionTokens: 4.40, contextWindow: 200000, supportsJson: true, reasoning: true },
      { id: 'o3', name: 'o3 (Reasoning)', costTier: '1x', costPerMillionTokens: 2.00, outputCostPerMillionTokens: 8.00, contextWindow: 200000, supportsJson: true, reasoning: true },
      { id: 'o3-pro', name: 'o3-pro (Heavy Reasoning)', costTier: '5x', costPerMillionTokens: 20.00, outputCostPerMillionTokens: 80.00, contextWindow: 200000, supportsJson: true, reasoning: true },
      { id: 'o3-mini', name: 'o3-mini (Reasoning)', costTier: '1x', costPerMillionTokens: 1.10, outputCostPerMillionTokens: 4.40, contextWindow: 200000, supportsJson: true, reasoning: true },
    ],
  },
  // ─── Anthropic (Paid) ──────────────────────────────────────
  'anthropic': {
    type: 'anthropic',
    name: 'Anthropic (Paid)',
    description: 'Claude Opus 4.6, Sonnet 4.5, Haiku 4.5. Up to 1M context (beta).',
    requiresApiKey: true,
    isFree: false,
    supportsGrounding: false,
    defaultModel: 'claude-sonnet-4-5-20260115',
    apiKeyHelpUrl: 'https://console.anthropic.com/settings/keys',
    apiKeyNote: 'Anthropic charges per token. Set spending limits at console.anthropic.com/settings/limits. Note: browser-direct calls require a CORS proxy.',
    models: [
      { id: 'claude-opus-4-6-20260115', name: 'Claude Opus 4.6', costTier: '5x', costPerMillionTokens: 5.00, outputCostPerMillionTokens: 25.00, contextWindow: 200000, supportsJson: true },
      { id: 'claude-sonnet-4-5-20260115', name: 'Claude Sonnet 4.5', costTier: '3x', costPerMillionTokens: 3.00, outputCostPerMillionTokens: 15.00, contextWindow: 200000, supportsJson: true },
      { id: 'claude-haiku-4-5-20260115', name: 'Claude Haiku 4.5', costTier: '1x', costPerMillionTokens: 1.00, outputCostPerMillionTokens: 5.00, contextWindow: 200000, supportsJson: true },
    ],
  },
  // ─── Qwen / Alibaba Cloud ─────────────────────────────────
  'qwen': {
    type: 'qwen',
    name: 'Qwen (Alibaba)',
    description: 'Qwen3 Max, Plus, Flash. 1M context. OpenAI-compatible API. Free quota on signup.',
    requiresApiKey: true,
    isFree: false,
    supportsGrounding: false,
    defaultModel: 'qwen-plus',
    apiKeyHelpUrl: 'https://www.alibabacloud.com/help/en/model-studio/get-api-key',
    apiKeyNote: 'Get an API key from Alibaba Cloud Model Studio. New accounts get 1M free tokens per model. OpenAI-compatible endpoint.',
    models: [
      { id: 'qwen3-max', name: 'Qwen3 Max', costTier: '1x', costPerMillionTokens: 1.20, outputCostPerMillionTokens: 6.00, contextWindow: 262144, supportsJson: true },
      { id: 'qwen-plus', name: 'Qwen Plus', costTier: '0.33x', costPerMillionTokens: 0.40, outputCostPerMillionTokens: 1.20, contextWindow: 1000000, supportsJson: true },
      { id: 'qwen-flash', name: 'Qwen Flash', costTier: '0x', costPerMillionTokens: 0.05, outputCostPerMillionTokens: 0.40, contextWindow: 1000000, supportsJson: true },
      { id: 'qwq-plus', name: 'QwQ Plus (Reasoning)', costTier: '1x', costPerMillionTokens: 0.80, outputCostPerMillionTokens: 2.40, contextWindow: 131072, supportsJson: true, reasoning: true },
    ],
  },
  // ─── DeepSeek (Paid) ──────────────────────────────────────
  'deepseek': {
    type: 'deepseek',
    name: 'DeepSeek (Paid)',
    description: 'DeepSeek V3 chat and R1 reasoning. OpenAI-compatible. Very affordable.',
    requiresApiKey: true,
    isFree: false,
    supportsGrounding: false,
    defaultModel: 'deepseek-chat',
    apiKeyHelpUrl: 'https://platform.deepseek.com/api_keys',
    apiKeyNote: 'DeepSeek API keys from platform.deepseek.com. Very competitive pricing. OpenAI-compatible endpoint.',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek V3', costTier: '0.33x', costPerMillionTokens: 0.27, outputCostPerMillionTokens: 1.10, contextWindow: 131072, supportsJson: true },
      { id: 'deepseek-reasoner', name: 'DeepSeek R1 (Reasoning)', costTier: '0.33x', costPerMillionTokens: 0.55, outputCostPerMillionTokens: 2.19, contextWindow: 131072, supportsJson: true, reasoning: true },
    ],
  },
  // ─── MiniMax (Paid) ───────────────────────────────────────
  'minimax': {
    type: 'minimax',
    name: 'MiniMax (Paid)',
    description: 'MiniMax M2.5 — SOTA productivity and coding. 205K context. OpenAI-compatible.',
    requiresApiKey: true,
    isFree: false,
    supportsGrounding: false,
    defaultModel: 'minimax-m2.5',
    apiKeyHelpUrl: 'https://www.minimax.io/platform',
    apiKeyNote: 'MiniMax API from minimax.io or via OpenRouter (openrouter.ai). OpenAI-compatible endpoint.',
    models: [
      { id: 'minimax-m2.5', name: 'MiniMax M2.5', costTier: '0.33x', costPerMillionTokens: 0.30, outputCostPerMillionTokens: 1.20, contextWindow: 205000, supportsJson: true },
    ],
  },
};

// ============================================================================
// AI Agent Role Types
// ============================================================================

export type AgentRole = 'writer' | 'critic' | 'extractor' | 'verifier' | 'fact-checker' | 'language-reviewer' | 'style-auditor';

export interface RoleAssignment {
  provider: AIProviderType;
  model?: string;
}

export type CriticParallelism = 'parallel' | 'sequential';

export interface CriticRunCounts {
  factChecker: number;
  languageReviewer: number;
  styleAuditor: number;
}

export interface RoleAssignments {
  writer?: RoleAssignment;
  critic?: RoleAssignment;
  extractor?: RoleAssignment;
  verifiers?: RoleAssignment[];
  factChecker?: RoleAssignment;
  languageReviewer?: RoleAssignment;
  styleAuditor?: RoleAssignment;
}

// ============================================================================
// Profile Builder Types
// ============================================================================

export interface BuilderRound {
  roundNumber: number;
  writerOutput: Partial<StagingDraft>;
  criticFeedback: CriticFeedback;
  timestamp: string;
}

export interface CriticIssue {
  id: string;
  severity: 'critical' | 'major' | 'minor' | 'suggestion' | 'fabrication';
  category: 'factual-error' | 'missing-source' | 'template-violation' | 'language-bias' | 'identity-mismatch' | 'unsupported-claim' | 'style' | 'fabricated-source';
  section: string;
  description: string;
  suggestion: string;
  resolved: boolean;
}

export interface CriticFeedback {
  issues: CriticIssue[];
  overallAssessment: string;
  overallScore: number; // 0-100 (deterministic — computed from issues, not AI-reported)
  templateComplianceScore: number; // 0-100
  /** Names of critic agents that failed completely (score treated as 0) */
  failedAgents?: string[];
}

export type ConvergenceMode = 'human-in-the-loop' | 'auto-converge' | 'fixed-rounds';

// ── Pipeline Modes ─────────────────────────────────────────
// Control how many API calls per profile — from full adversarial to draft-only.

export type PipelineMode = 'thorough' | 'balanced' | 'fast' | 'draft';

export type CriticMode = 'specialized' | 'combined';

export type AuditMode = 'multi-verifier' | 'single-verifier' | 'skip';

// ── Gemini Billing Tier ────────────────────────────────────
// Determines rate limits and whether API calls cost money.
// Source: https://ai.google.dev/gemini-api/docs/rate-limits

export type GeminiTier = 'free' | 'tier1' | 'tier2' | 'tier3';

export interface GeminiTierConfig {
  label: string;
  description: string;
  qualification: string;
  estimatedRpm: number;
  estimatedRpd: number;
  chargesPerToken: boolean;
  dataUsedByGoogle: boolean;
}

export const GEMINI_TIER_INFO: Record<GeminiTier, GeminiTierConfig> = {
  free: {
    label: 'Free',
    description: '$0 — no billing account needed. Lower rate limits. Data may be used to improve Google products.',
    qualification: 'Default for users in eligible countries — no billing needed.',
    estimatedRpm: 15,
    estimatedRpd: 1500,
    chargesPerToken: false,
    dataUsedByGoogle: true,
  },
  tier1: {
    label: 'Paid Tier 1',
    description: 'Per-token pricing. Higher rate limits (~1,000 RPM). Data NOT used to improve Google products.',
    qualification: 'Billing account linked to your Google Cloud project.',
    estimatedRpm: 1000,
    estimatedRpd: 10000,
    chargesPerToken: true,
    dataUsedByGoogle: false,
  },
  tier2: {
    label: 'Paid Tier 2',
    description: 'Even higher rate limits (~2,000 RPM). Per-token pricing.',
    qualification: 'Total Cloud spend > $250 and 30+ days since first payment.',
    estimatedRpm: 2000,
    estimatedRpd: 10000,
    chargesPerToken: true,
    dataUsedByGoogle: false,
  },
  tier3: {
    label: 'Paid Tier 3',
    description: 'Highest rate limits (~4,000 RPM). Per-token pricing.',
    qualification: 'Total Cloud spend > $1,000 and 30+ days since first payment.',
    estimatedRpm: 4000,
    estimatedRpd: 10000,
    chargesPerToken: true,
    dataUsedByGoogle: false,
  },
};

export const PIPELINE_MODE_INFO: Record<PipelineMode, { label: string; description: string; approxCalls: string }> = {
  thorough: {
    label: 'Thorough',
    description: 'Full adversarial loop (3 rounds), 3 specialized critics, multi-verifier audit.',
    approxCalls: '~43 calls',
  },
  balanced: {
    label: 'Balanced',
    description: '2 rounds, 1 combined critic, single-verifier audit. Good accuracy at ~60% fewer calls.',
    approxCalls: '~18 calls',
  },
  fast: {
    label: 'Fast',
    description: '1 round, 1 combined critic, single-verifier audit. Quick turnaround.',
    approxCalls: '~12 calls',
  },
  draft: {
    label: 'Draft Only',
    description: 'Writer only — no critics, no audit. Fastest possible, for initial drafts.',
    approxCalls: '~5 calls',
  },
};

// ============================================================================
// Audit / Verification Types
// ============================================================================

export interface ExtractedClaim {
  id: string;
  text: string;
  sourceUrl: string;
  supportingQuote: string;
  section: string;
  category: StanceCategoryKey | 'bio-personal' | 'bio-professional' | 'bio-political';
  claimType: 'fact' | 'stance' | 'background' | 'quote';
}

export type VerificationVerdict = 'verified' | 'contradicted' | 'unverified' | 'no-consensus';

export interface VerifierResult {
  verifierId: string;
  providerUsed: string;
  model: string;
  verdict: VerificationVerdict;
  confidence: number;
  explanation: string;
  identityCheck: boolean;
  identityMismatch: boolean;
  supportingEvidence: string;
  timestamp: string;
}

export interface ClaimAuditResult {
  claim: ExtractedClaim;
  verifierResults: VerifierResult[];
  consensus: VerificationVerdict;
  confidence: number;
  explanation: string;
  /** True if any verifier found source/person mismatch for this claim */
  identityMismatch?: boolean;
  needsHumanReview?: boolean;
  /** Manual reviewer override from UI workflow */
  userOverride?: 'flip' | null;
  userNote?: string;
  /** URL validation results from the urlValidator service */
  urlValidation?: {
    exists: boolean;
    quoteFound: boolean;
    method: string;
    status: string;
  };
}

export interface AuditReport {
  id: string;
  candidateName: string;
  timestamp: string;
  results: ClaimAuditResult[];
  summary: {
    totalClaims: number;
    verified: number;
    contradicted: number;
    unverified: number;
    overallConfidence: number;
  };
}

// ============================================================================
// Structured Candidate Links
// ============================================================================

/** All the social platform types we track */
export type SocialPlatform = 'facebook' | 'twitter' | 'instagram' | 'linkedin' | 'youtube' | 'tiktok';

/** Structured links display — social media with account types, website, articles */
export interface CandidateLinks {
  /** Primary candidate/campaign website — most important */
  candidateWebsite: LinkItem | null;
  /** Categorized social media links */
  socialMedia: LinkItem[];
  /** Article sources with paywall tags */
  articles: Source[];
  /** Platforms that were searched even if no link was found (to show checkmarks) */
  searchedPlatforms: SocialPlatform[];
}

// ============================================================================
// HTML Ingest Types
// ============================================================================

export interface ExtractedProfile {
  candidateName: string;
  links: LinkItem[];
  bios: {
    personal: string;
    professional: string;
    political: string;
  };
  issues: Array<{
    key: string;
    title: string;
    stances: Array<{
      text: string;
      sourceUrl: string;
      quote: string;
    }>;
  }>;
  sources: Source[];
  rawText: string;
}

// ============================================================================
// App State Types
// ============================================================================

export type AppTab = 'import' | 'build' | 'audit' | 'settings';

export interface AppSettings {
  apiKeys: Partial<Record<AIProviderType, string>>;
  roleAssignments?: RoleAssignments;
  convergenceMode: ConvergenceMode;
  maxAdversarialRounds: number;
  convergenceThreshold: number;
  theme: 'light' | 'dark';
  /** Max monthly spend in USD — 0 means unlimited */
  spendingCapUsd: number;
  /** Accumulated estimated spend this month in USD */
  currentMonthSpendUsd: number;
  /** YYYY-MM of the current tracking month */
  spendingMonth: string;
  /** Selected model overrides per role */
  modelOverrides?: Partial<Record<string, string>>;
  /** Whether the 3 specialized critics run in parallel or sequentially */
  criticParallelism?: CriticParallelism;
  /** How many times each specialized critic runs per adversarial round */
  criticRunCounts?: CriticRunCounts;
  /** Pipeline mode — controls call count / quality tradeoff */
  pipelineMode?: PipelineMode;
  /** Critic approach — 3 specialized agents or 1 combined (auto-set by pipeline mode) */
  criticMode?: CriticMode;
  /** Audit approach — multi-verifier, single, or skip */
  auditMode?: AuditMode;
  /** Gemini billing tier — determines rate limits and real costs */
  geminiTier?: GeminiTier;
}

export const DEFAULT_SETTINGS: AppSettings = {
  apiKeys: {},
  roleAssignments: {
    writer: { provider: 'gemini-free' },
    critic: { provider: 'gemini-free' },
    extractor: { provider: 'gemini-free' },
    verifiers: [{ provider: 'gemini-free' }],
    factChecker: { provider: 'gemini-free' },
    languageReviewer: { provider: 'gemini-free' },
    styleAuditor: { provider: 'gemini-free' },
  },
  convergenceMode: 'human-in-the-loop',
  maxAdversarialRounds: 3,
  convergenceThreshold: 80,
  theme: 'light',
  spendingCapUsd: 0,
  currentMonthSpendUsd: 0,
  spendingMonth: new Date().toISOString().slice(0, 7),
  criticParallelism: 'parallel',
  criticRunCounts: { factChecker: 1, languageReviewer: 1, styleAuditor: 1 },
  pipelineMode: 'balanced',
  criticMode: 'combined',
  auditMode: 'single-verifier',
  geminiTier: 'free',
};

// ============================================================================
// Session / Workspace Types
// ============================================================================

export interface AdditionalSource {
  url: string;
  title: string;
  addedAt: string;
}

export interface CandidateSession {
  id: string;
  candidateName: string;
  createdAt: string;
  updatedAt: string;
  currentDraft: Partial<StagingDraft> | null;
  builderRounds: BuilderRound[];
  auditReports: AuditReport[];
  importedHtml: string | null;
  extractedProfile: ExtractedProfile | null;
  additionalSources: AdditionalSource[];
  candidateLinks?: CandidateLinks;
  status: 'importing' | 'building' | 'ready-for-audit' | 'audited' | 'complete';
  /** Activity log from the build process — persisted across navigation */
  buildLog?: string[];
  /** Source provenance check results — deterministic URL verification */
  provenanceSummary?: {
    totalUrls: number;
    fromInput: number;
    fabricated: number;
    fabricatedUrls: string[];
  };
  /** Metadata from batch import or manual entry */
  metadata?: CandidateMetadata;
}

// ============================================================================
// Candidate Metadata (matches Branch API structure)
// ============================================================================

export interface CandidateMetadata {
  election?: string;       // e.g. "2026-texas-primary-election"
  party?: string;          // e.g. "D", "R", "I", "L", "G"
  officeName?: string;     // e.g. "District Attorney"
  officeKey?: string;      // e.g. "tx-state-district-attorney"
  districtType?: string;   // e.g. "county", "state", "city"
  districtName?: string;   // e.g. "Bexar County"
  state?: string;          // e.g. "TX"
  raceKey?: string;        // e.g. "2026-texas-primary-election-tx-state-district-attorney-tx-county-bexar-d"
  issuesToCover?: string[];
  priorityLevel?: string;
  incumbent?: boolean;
}

// ============================================================================
// Batch Queue Types
// ============================================================================

export type BatchItemStatus = 'queued' | 'importing' | 'building' | 'auditing' | 'complete' | 'error' | 'skipped' | 'paused';

export interface BatchQueueItem {
  id: string;
  candidateName: string;
  metadata: CandidateMetadata;
  sessionId?: string;      // linked CandidateSession once created
  status: BatchItemStatus;
  error?: string;
  htmlFile?: string;       // filename if uploaded
  importedHtml?: string;   // raw HTML content (for HTML imports)
  extractedProfile?: ExtractedProfile | null; // parsed from HTML import
  startedAt?: string;
  completedAt?: string;
}

export interface BatchQueue {
  id: string;
  name: string;
  createdAt: string;
  items: BatchQueueItem[];
  autoRun: boolean;
  concurrency: number; // how many to process at once (usually 1 for rate limits)
}

/** Cost tier labels shown to user */
export const COST_TIER_LABELS: Record<ModelInfo['costTier'], { label: string; color: string }> = {
  '0x':    { label: 'Free',       color: 'text-green-600' },
  '0.33x': { label: 'Budget',    color: 'text-blue-600' },
  '1x':    { label: 'Standard',  color: 'text-yellow-600' },
  '3x':    { label: 'Premium',   color: 'text-orange-600' },
  '5x':    { label: 'Enterprise', color: 'text-red-600' },
};

// ============================================================================
// Cost Tracking Types
// ============================================================================

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface APICallRecord {
  id: string;
  timestamp: string;
  provider: AIProviderType;
  model: string;
  /** Which pipeline step: writer, critic, extractor, verifier, etc. */
  role: string;
  /** The candidate session this call belongs to (if any) */
  sessionId?: string;
  candidateName?: string;
  usage: TokenUsage;
  /** Computed cost in USD */
  costUsd: number;
  /** Duration in ms */
  durationMs: number;
  /** Whether the call succeeded or errored */
  success: boolean;
  error?: string;
}

export interface CostSummary {
  totalCostUsd: number;
  totalCalls: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  byProvider: Record<string, { costUsd: number; calls: number }>;
  byModel: Record<string, { costUsd: number; calls: number }>;
  byRole: Record<string, { costUsd: number; calls: number }>;
  bySession: Record<string, { costUsd: number; calls: number; candidateName: string }>;
}
