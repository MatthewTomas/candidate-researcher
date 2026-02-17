/**
 * Gemini Provider — supports both free and paid tiers.
 * Paid tier enables Google Search Grounding for verification.
 */

import { GoogleGenAI } from '@google/genai';
import type { AIProvider, AIGenerateOptions } from '../aiProvider';
import type { AIProviderType } from '../../types';
import { AI_PROVIDERS } from '../../types';
import { parseJSONResponse } from '../jsonParser';

export class GeminiProvider implements AIProvider {
  readonly type: AIProviderType;
  readonly model: string;
  private client: GoogleGenAI;
  private isPaid: boolean;

  constructor(apiKey: string, type: 'gemini-free' | 'gemini-paid', model?: string) {
    this.type = type;
    this.isPaid = type === 'gemini-paid';
    this.model = model || AI_PROVIDERS[type].defaultModel;
    this.client = new GoogleGenAI({ apiKey });
  }

  async generateText(prompt: string, options?: AIGenerateOptions): Promise<string> {
    const config: Record<string, unknown> = {};
    if (options?.temperature !== undefined) config.temperature = options.temperature;
    if (options?.maxTokens) config.maxOutputTokens = options.maxTokens;
    if (options?.jsonMode) config.responseMimeType = 'application/json';
    if (options?.systemPrompt) config.systemInstruction = options.systemPrompt;

    const response = await this.client.models.generateContent({
      model: this.model,
      contents: prompt,
      config,
    });

    return response.text ?? '';
  }

  async generateJSON<T>(prompt: string, options?: AIGenerateOptions): Promise<T> {
    const jsonPrompt = `${prompt}\n\nRespond ONLY with valid JSON. No markdown code fences, no explanation outside the JSON.`;
    const text = await this.generateText(jsonPrompt, { ...options, jsonMode: true });
    return parseJSONResponse<T>(text, 'Gemini');
  }

  async verifyWithGrounding(prompt: string, options?: AIGenerateOptions): Promise<string> {
    const config: Record<string, unknown> = {};
    if (options?.temperature !== undefined) config.temperature = options.temperature;
    if (options?.maxTokens) config.maxOutputTokens = options.maxTokens;
    if (options?.jsonMode) config.responseMimeType = 'application/json';

    // Only paid tier gets grounding
    const tools = this.isPaid ? [{ googleSearch: {} }] : [];
    if (options?.systemPrompt) config.systemInstruction = options.systemPrompt;

    const response = await this.client.models.generateContent({
      model: this.model,
      contents: prompt,
      config: { ...config, tools },
    });

    return response.text ?? '';
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
