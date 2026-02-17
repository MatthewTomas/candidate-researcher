/**
 * OpenAI-Compatible Provider Base
 *
 * Many providers (Qwen, DeepSeek, MiniMax) expose an OpenAI-compatible
 * /v1/chat/completions endpoint. This base class handles the common logic
 * so each provider only needs to supply its base URL and defaults.
 */

import type { AIProvider, AIGenerateOptions } from '../aiProvider';
import type { AIProviderType } from '../../types';
import { parseJSONResponse } from '../jsonParser';

export class OpenAICompatibleProvider implements AIProvider {
  readonly type: AIProviderType;
  readonly model: string;
  private apiKey: string;
  private baseUrl: string;

  constructor(
    type: AIProviderType,
    apiKey: string,
    model: string,
    baseUrl: string,
  ) {
    this.type = type;
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, ''); // strip trailing slash
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

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
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
      throw new Error(`${this.type} API error ${response.status}: ${error}`);
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
    return parseJSONResponse<T>(text, String(this.type));
  }

  async verifyWithGrounding(prompt: string, options?: AIGenerateOptions): Promise<string> {
    // These providers don't support web search grounding — fall back to normal generation
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
