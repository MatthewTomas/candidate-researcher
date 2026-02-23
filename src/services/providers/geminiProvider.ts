/**
 * Gemini Provider — supports both free and paid tiers.
 * Paid tier enables Google Search Grounding for verification.
 */

import { GoogleGenAI } from '@google/genai';
import type { AIProvider, AIGenerateOptions, ChatTurn } from '../aiProvider';
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

    const contentPromise = this.client.models.generateContent({
      model: this.model,
      contents: prompt,
      config,
    });
    const abortPromise = options?.signal
      ? new Promise<never>((_, reject) => {
          if (options.signal!.aborted) {
            reject(new DOMException('Operation aborted', 'AbortError'));
            return;
          }
          options.signal!.addEventListener(
            'abort', () => reject(new DOMException('Operation aborted', 'AbortError')), { once: true },
          );
        })
      : null;
    const response = await (abortPromise ? Promise.race([contentPromise, abortPromise]) : contentPromise);

    return response.text ?? '';
  }

  async generateJSON<T>(prompt: string, options?: AIGenerateOptions): Promise<T> {
    const jsonPrompt = `${prompt}\n\nRespond ONLY with valid JSON. No markdown code fences, no explanation outside the JSON.`;
    const text = await this.generateText(jsonPrompt, { ...options, jsonMode: true });
    return parseJSONResponse<T>(text, 'Gemini');
  }

  /**
   * Multi-turn JSON generation using Gemini's native conversation history.
   * The source material only needs to be in the first user turn — subsequent
   * turns reference it through conversation context, eliminating redundant re-sends.
   *
   * `history` is an array of prior turns (user/assistant alternating).
   * Returns the parsed JSON result AND the updated history with the new turns appended.
   */
  async generateJSONWithHistory<T>(
    history: ChatTurn[],
    newUserMessage: string,
    options?: AIGenerateOptions,
  ): Promise<{ result: T; updatedHistory: ChatTurn[] }> {
    const config: Record<string, unknown> = {
      responseMimeType: 'application/json',
    };
    if (options?.temperature !== undefined) config.temperature = options.temperature;
    if (options?.maxTokens) config.maxOutputTokens = options.maxTokens;
    if (options?.systemPrompt) config.systemInstruction = options.systemPrompt;

    // Build the Gemini contents array from history + new message
    const jsonMessage = `${newUserMessage}\n\nRespond ONLY with valid JSON. No markdown code fences, no explanation outside the JSON.`;
    const contents = [
      ...history.map(turn => ({ role: turn.role === 'assistant' ? 'model' : 'user', parts: [{ text: turn.content }] })),
      { role: 'user', parts: [{ text: jsonMessage }] },
    ];

    const chatContentPromise = this.client.models.generateContent({
      model: this.model,
      contents,
      config,
    });
    const chatAbortPromise = options?.signal
      ? new Promise<never>((_, reject) => {
          if (options.signal!.aborted) {
            reject(new DOMException('Operation aborted', 'AbortError'));
            return;
          }
          options.signal!.addEventListener(
            'abort', () => reject(new DOMException('Operation aborted', 'AbortError')), { once: true },
          );
        })
      : null;
    const response = await (chatAbortPromise ? Promise.race([chatContentPromise, chatAbortPromise]) : chatContentPromise);

    const text = response.text ?? '';
    const result = parseJSONResponse<T>(text, 'Gemini (chat)');

    // Append both turns to the history
    const updatedHistory: ChatTurn[] = [
      ...history,
      { role: 'user', content: newUserMessage },
      { role: 'assistant', content: text },
    ];

    return { result, updatedHistory };
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
