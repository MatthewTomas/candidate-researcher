/**
 * MiniMax Provider — MiniMax M2.5
 * OpenAI-compatible endpoint at api.minimax.chat
 * Can also be used via OpenRouter (openrouter.ai)
 */

import { OpenAICompatibleProvider } from './openaiCompatibleProvider';
import { AI_PROVIDERS } from '../../types';

const MINIMAX_BASE_URL = 'https://api.minimax.chat/v1';

export class MiniMaxProvider extends OpenAICompatibleProvider {
  constructor(apiKey: string, model?: string) {
    super('minimax', apiKey, model || AI_PROVIDERS.minimax.defaultModel, MINIMAX_BASE_URL);
  }
}
