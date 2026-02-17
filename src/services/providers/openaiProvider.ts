/**
 * OpenAI Provider — GPT-4o family (paid).
 * Uses fetch directly to avoid bundling the full openai SDK.
 */

import type { AIProvider, AIGenerateOptions } from '../aiProvider';
import type { AIProviderType } from '../../types';
import { AI_PROVIDERS } from '../../types';
import { parseJSONResponse } from '../jsonParser';

export class OpenAIProvider implements AIProvider {
  readonly type: AIProviderType = 'openai';
  readonly model: string;
  private apiKey: string;

  constructor(apiKey: string, model?: string) {
    this.model = model || AI_PROVIDERS.openai.defaultModel;
    this.apiKey = apiKey;
  }

  private async callAPI(messages: Array<{ role: string; content: string }>, options?: AIGenerateOptions): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 4096,
    };

    if (options?.jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${error}`);
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
    const jsonPrompt = `${prompt}\n\nRespond ONLY with valid JSON.`;
    const text = await this.generateText(jsonPrompt, { ...options, jsonMode: true });
    return parseJSONResponse<T>(text, 'OpenAI');
  }

  async verifyWithGrounding(prompt: string, options?: AIGenerateOptions): Promise<string> {
    // OpenAI does not have built-in grounding — normal generation
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
