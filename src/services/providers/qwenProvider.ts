/**
 * Qwen Provider — Alibaba Cloud Model Studio
 * OpenAI-compatible endpoint at dashscope-intl.aliyuncs.com
 */

import { OpenAICompatibleProvider } from './openaiCompatibleProvider';
import { AI_PROVIDERS } from '../../types';

const QWEN_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';

export class QwenProvider extends OpenAICompatibleProvider {
  constructor(apiKey: string, model?: string) {
    super('qwen', apiKey, model || AI_PROVIDERS.qwen.defaultModel, QWEN_BASE_URL);
  }
}
