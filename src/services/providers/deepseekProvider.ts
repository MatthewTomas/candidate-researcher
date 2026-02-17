/**
 * DeepSeek Provider — DeepSeek V3 & R1
 * OpenAI-compatible endpoint at api.deepseek.com
 */

import { OpenAICompatibleProvider } from './openaiCompatibleProvider';
import { AI_PROVIDERS } from '../../types';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(apiKey: string, model?: string) {
    super('deepseek', apiKey, model || AI_PROVIDERS.deepseek.defaultModel, DEEPSEEK_BASE_URL);
  }
}
