/**
 * HuggingFace Inference API Provider — free tier with Mistral/Llama models.
 */

import { HfInference } from '@huggingface/inference';
import type { AIProvider, AIGenerateOptions } from '../aiProvider';
import type { AIProviderType } from '../../types';
import { AI_PROVIDERS } from '../../types';
import { parseJSONResponse } from '../jsonParser';

export class HuggingFaceProvider implements AIProvider {
  readonly type: AIProviderType = 'huggingface';
  readonly model: string;
  private client: HfInference;

  constructor(apiKey: string, model?: string) {
    this.model = model || AI_PROVIDERS.huggingface.defaultModel;
    this.client = new HfInference(apiKey);
  }

  async generateText(prompt: string, options?: AIGenerateOptions): Promise<string> {
    const fullPrompt = options?.systemPrompt
      ? `<s>[INST] ${options.systemPrompt}\n\n${prompt} [/INST]`
      : `<s>[INST] ${prompt} [/INST]`;

    const response = await this.client.textGeneration({
      model: this.model,
      inputs: fullPrompt,
      parameters: {
        max_new_tokens: options?.maxTokens ?? 2048,
        temperature: options?.temperature ?? 0.7,
        return_full_text: false,
      },
    });

    return response.generated_text;
  }

  async generateJSON<T>(prompt: string, options?: AIGenerateOptions): Promise<T> {
    const jsonPrompt = `${prompt}\n\nRespond ONLY with valid JSON. No markdown code fences, no explanation.`;
    const text = await this.generateText(jsonPrompt, options);
    return parseJSONResponse<T>(text, 'HuggingFace');
  }

  async verifyWithGrounding(prompt: string, options?: AIGenerateOptions): Promise<string> {
    // HuggingFace does not support grounding — normal generation
    return this.generateText(prompt, options);
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await this.generateText('Reply with exactly one word: OK');
      return response.toLowerCase().includes('ok');
    } catch {
      return false;
    }
  }
}
