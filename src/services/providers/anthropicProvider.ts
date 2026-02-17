/**
 * Anthropic Provider — Claude models (paid).
 * Uses fetch directly against the Anthropic Messages API.
 * Note: Anthropic requires CORS proxy in browser — user needs to configure one
 * or use this from a deployed backend. For local dev, we provide instructions.
 */

import type { AIProvider, AIGenerateOptions } from '../aiProvider';
import type { AIProviderType } from '../../types';
import { AI_PROVIDERS } from '../../types';
import { parseJSONResponse } from '../jsonParser';

export class AnthropicProvider implements AIProvider {
  readonly type: AIProviderType = 'anthropic';
  readonly model: string;
  private apiKey: string;

  constructor(apiKey: string, model?: string) {
    this.model = model || AI_PROVIDERS.anthropic.defaultModel;
    this.apiKey = apiKey;
  }

  private async callAPI(prompt: string, systemPrompt?: string, options?: AIGenerateOptions): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: options?.maxTokens ?? 4096,
      messages: [{ role: 'user', content: prompt }],
    };

    if (systemPrompt) body.system = systemPrompt;
    if (options?.temperature !== undefined) body.temperature = options.temperature;

    // Note: Anthropic API doesn't support direct browser calls due to CORS.
    // For local development, use a CORS proxy or Vite proxy config.
    const response = await fetch('/api/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${error}`);
    }

    const data = await response.json();
    const textBlock = data.content?.find((b: { type: string }) => b.type === 'text');
    return textBlock?.text ?? '';
  }

  async generateText(prompt: string, options?: AIGenerateOptions): Promise<string> {
    return this.callAPI(prompt, options?.systemPrompt, options);
  }

  async generateJSON<T>(prompt: string, options?: AIGenerateOptions): Promise<T> {
    const jsonPrompt = `${prompt}\n\nRespond ONLY with valid JSON. No markdown code fences.`;
    const text = await this.callAPI(jsonPrompt, options?.systemPrompt, options);
    return parseJSONResponse<T>(text, 'Anthropic');
  }

  async verifyWithGrounding(prompt: string, options?: AIGenerateOptions): Promise<string> {
    // Anthropic does not have built-in grounding
    return this.generateText(prompt, options);
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await this.generateText('Reply with exactly: OK');
      return response.toLowerCase().includes('ok');
    } catch {
      return false;
    }
  }
}
