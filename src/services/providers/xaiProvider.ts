/**
 * xAI Provider (Grok models).
 * Uses direct fetch against xAI's OpenAI-compatible chat completions API.
 */

import type { AIProvider, AIGenerateOptions } from '../aiProvider';
import type { AIProviderType } from '../../types';
import { AI_PROVIDERS } from '../../types';
import { parseJSONResponse } from '../jsonParser';

const XAI_API_URL = 'https://api.x.ai/v1/chat/completions';

export class XaiProvider implements AIProvider {
  readonly type: AIProviderType = 'xai';
  readonly model: string;
  private apiKey: string;

  constructor(apiKey: string, model?: string) {
    this.model = model || AI_PROVIDERS.xai.defaultModel;
    this.apiKey = apiKey;
  }

  private async callAPI(
    messages: Array<{ role: string; content: string }>,
    options?: AIGenerateOptions,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 4096,
    };

    if (options?.jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const response = await fetch(XAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`xAI API error ${response.status}: ${error}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content ?? '';
  }

  async generateText(prompt: string, options?: AIGenerateOptions): Promise<string> {
    const messages: Array<{ role: string; content: string }> = [];
    if (options?.systemPrompt) messages.push({ role: 'system', content: options.systemPrompt });
    messages.push({ role: 'user', content: prompt });
    return this.callAPI(messages, options);
  }

  async generateJSON<T>(prompt: string, options?: AIGenerateOptions): Promise<T> {
    const jsonPrompt = `${prompt}\n\nRespond ONLY with valid JSON. No markdown, no explanation.`;
    const text = await this.generateText(jsonPrompt, { ...options, jsonMode: true });
    return parseJSONResponse<T>(text, 'xAI');
  }

  async verifyWithGrounding(prompt: string, options?: AIGenerateOptions): Promise<string> {
    // Grounding/search tools are supported by xAI, but this provider currently
    // uses plain text generation for deterministic pipeline cost behavior.
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
