/**
 * AI Provider Abstraction Layer
 * 
 * Common interface that all AI backends implement, enabling:
 * - Hot-swapping models per agent role
 * - Multi-verifier consensus (same prompt to N different providers)
 * - Free/paid tier toggling
 */

import type { AIProviderType } from '../types';
import { recordAPICall } from './costTracker';
import { rateLimiter } from './rateLimiter';

// --- Common interface ---

export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AIGenerateOptions {
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  systemPrompt?: string;
  /** AbortSignal for cancelling in-flight requests */
  signal?: AbortSignal;
}

export interface AIProvider {
  readonly type: AIProviderType;
  readonly model: string;

  /** Simple text generation */
  generateText(prompt: string, options?: AIGenerateOptions): Promise<string>;

  /** Structured JSON generation (will parse and validate) */
  generateJSON<T>(prompt: string, options?: AIGenerateOptions): Promise<T>;

  /** Verification with optional web search grounding (only some providers support this) */
  verifyWithGrounding(prompt: string, options?: AIGenerateOptions): Promise<string>;

  /** Test that the API key works */
  testConnection(): Promise<boolean>;
}

// --- Provider Factory ---

export async function createProvider(type: AIProviderType, apiKey: string, model?: string): Promise<AIProvider> {
  switch (type) {
    case 'gemini-free':
    case 'gemini-paid': {
      const { GeminiProvider } = await import('./providers/geminiProvider');
      return new GeminiProvider(apiKey, type, model);
    }
    case 'xai': {
      const { XaiProvider } = await import('./providers/xaiProvider');
      return new XaiProvider(apiKey, model);
    }
    case 'huggingface': {
      const { HuggingFaceProvider } = await import('./providers/huggingfaceProvider');
      return new HuggingFaceProvider(apiKey, model);
    }
    case 'openai': {
      const { OpenAIProvider } = await import('./providers/openaiProvider');
      return new OpenAIProvider(apiKey, model);
    }
    case 'anthropic': {
      const { AnthropicProvider } = await import('./providers/anthropicProvider');
      return new AnthropicProvider(apiKey, model);
    }
    case 'qwen': {
      const { QwenProvider } = await import('./providers/qwenProvider');
      return new QwenProvider(apiKey, model);
    }
    case 'deepseek': {
      const { DeepSeekProvider } = await import('./providers/deepseekProvider');
      return new DeepSeekProvider(apiKey, model);
    }
    case 'minimax': {
      const { MiniMaxProvider } = await import('./providers/minimaxProvider');
      return new MiniMaxProvider(apiKey, model);
    }
    default:
      throw new Error(`Unknown provider type: ${type}`);
  }
}

// --- Tracked Provider Wrapper ---
// Wraps any AIProvider to automatically record cost/usage for every call.

/** Rough token estimator: 1 token ≈ 4 chars for English text */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface TrackedProviderOptions {
  role: string;          // e.g. 'writer', 'critic', 'extractor', 'verifier'
  sessionId?: string;
  candidateName?: string;
}

export class TrackedProvider implements AIProvider {
  readonly type: AIProviderType;
  readonly model: string;
  private inner: AIProvider;
  private opts: TrackedProviderOptions;

  constructor(inner: AIProvider, opts: TrackedProviderOptions) {
    this.inner = inner;
    this.type = inner.type;
    this.model = inner.model;
    this.opts = opts;
  }

  private async track<T>(prompt: string, fn: () => Promise<T>): Promise<T> {
    // Proactive rate limiting — wait for clearance before making the call
    await rateLimiter.acquire(this.type);

    const start = performance.now();
    let success = true;
    let errorMsg: string | undefined;
    let resultText = '';

    try {
      const result = await fn();
      resultText = typeof result === 'string' ? result : JSON.stringify(result);
      rateLimiter.reportSuccess(this.type);
      return result;
    } catch (err: any) {
      success = false;
      errorMsg = err?.message?.slice(0, 200);
      // Detect rate-limit errors and report to limiter for adaptive backoff
      const lower = (errorMsg || '').toLowerCase();
      if (lower.includes('429') || lower.includes('rate limit') || lower.includes('quota') || lower.includes('resource_exhausted')) {
        rateLimiter.reportThrottled(this.type);
      }
      throw err;
    } finally {
      const durationMs = Math.round(performance.now() - start);
      const promptTokens = estimateTokens(prompt);
      const completionTokens = estimateTokens(resultText);

      recordAPICall({
        provider: this.type,
        model: this.model,
        role: this.opts.role,
        sessionId: this.opts.sessionId,
        candidateName: this.opts.candidateName,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
        durationMs,
        success,
        error: errorMsg,
      });
    }
  }

  async generateText(prompt: string, options?: AIGenerateOptions): Promise<string> {
    const fullPrompt = options?.systemPrompt ? `${options.systemPrompt}\n\n${prompt}` : prompt;
    return this.track(fullPrompt, () => this.inner.generateText(prompt, options));
  }

  async generateJSON<T>(prompt: string, options?: AIGenerateOptions): Promise<T> {
    const fullPrompt = options?.systemPrompt ? `${options.systemPrompt}\n\n${prompt}` : prompt;
    return this.track(fullPrompt, () => this.inner.generateJSON<T>(prompt, options));
  }

  async verifyWithGrounding(prompt: string, options?: AIGenerateOptions): Promise<string> {
    const fullPrompt = options?.systemPrompt ? `${options.systemPrompt}\n\n${prompt}` : prompt;
    return this.track(fullPrompt, () => this.inner.verifyWithGrounding(prompt, options));
  }

  async testConnection(): Promise<boolean> {
    return this.inner.testConnection();
  }
}

/** Create a provider wrapped with cost tracking */
export async function createTrackedProvider(
  type: AIProviderType,
  apiKey: string,
  opts: TrackedProviderOptions,
  model?: string,
): Promise<AIProvider> {
  const inner = await createProvider(type, apiKey, model);
  return new TrackedProvider(inner, opts);
}
