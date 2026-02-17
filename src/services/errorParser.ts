/**
 * Error parsing utilities for AI API errors.
 * Converts raw error messages into user-friendly, actionable notices.
 */

export interface ParsedError {
  /** Short user-friendly title */
  title: string;
  /** Friendly explanation of what happened */
  message: string;
  /** Raw error details for debugging */
  details?: string;
  /** Category for UI handling */
  category: 'quota' | 'auth' | 'budget' | 'network' | 'parse' | 'config' | 'unknown';
  /** Whether the user should retry */
  retryable: boolean;
  /** Suggested action */
  action?: string;
}

/**
 * Parse a raw API error into a user-friendly structure.
 */
export function parseAPIError(error: unknown): ParsedError {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();

  // ── Rate limit / Quota exhausted ──────────────────
  if (lower.includes('429') || lower.includes('resource_exhausted') || lower.includes('quota') || lower.includes('rate limit')) {
    const isFreeTier = lower.includes('free_tier') || lower.includes('freetier') || lower.includes('free tier');
    return {
      title: 'API Quota Exceeded',
      message: isFreeTier
        ? 'You\'ve hit the free-tier rate limit for this model. Free-tier Gemini limits are quite strict (especially for gemini-3-pro). Try waiting a few minutes, switching to a different model (e.g. Flash), or using a paid API key.'
        : 'The API provider rate-limited this request. This usually means too many requests in a short time. Wait a minute and try again, or switch to a different provider.',
      details: msg,
      category: 'quota',
      retryable: true,
      action: isFreeTier ? 'Switch to a free Flash model or wait 1-2 minutes' : 'Wait and retry, or switch providers',
    };
  }

  // ── Spending cap ──────────────────────────────────
  if (lower.includes('spending cap') || lower.includes('budget limit') || lower.includes('monthly spend')) {
    return {
      title: 'Spending Cap Reached',
      message: msg,
      category: 'budget',
      retryable: false,
      action: 'Increase your spending cap in Settings, or switch all roles to free-tier models',
    };
  }

  // ── Auth / API Key ────────────────────────────────
  if (lower.includes('401') || lower.includes('403') || lower.includes('unauthorized') || lower.includes('invalid api key') || lower.includes('no api key')) {
    return {
      title: 'Authentication Error',
      message: 'The API key for this provider is missing or invalid. Check your API keys in Settings.',
      details: msg,
      category: 'auth',
      retryable: false,
      action: 'Go to Settings and update your API key',
    };
  }

  // ── Network errors ────────────────────────────────
  if (lower.includes('fetch') || lower.includes('network') || lower.includes('econnrefused') || lower.includes('cors') || lower.includes('timeout')) {
    return {
      title: 'Network Error',
      message: 'Could not reach the AI provider. Check your internet connection and try again.',
      details: msg,
      category: 'network',
      retryable: true,
      action: 'Check connection and retry',
    };
  }

  // ── JSON parse errors ─────────────────────────────
  if (lower.includes('json') || lower.includes('parse') || lower.includes('unexpected token')) {
    return {
      title: 'Response Parse Error',
      message: 'The AI returned an invalid response that couldn\'t be parsed. This sometimes happens — try running again.',
      details: msg,
      category: 'parse',
      retryable: true,
      action: 'Try again — the model may produce valid output on retry',
    };
  }

  // ── Config errors ─────────────────────────────────
  if (lower.includes('no api key configured') || lower.includes('go to settings')) {
    return {
      title: 'Configuration Needed',
      message: msg,
      category: 'config',
      retryable: false,
      action: 'Go to Settings and add the required API key',
    };
  }

  // ── Model not found (404) ─────────────────────────
  if (lower.includes('404') || lower.includes('not found') || lower.includes('model not found')) {
    return {
      title: 'Model Not Found',
      message: 'The selected AI model could not be found. It may have been deprecated or the model ID is wrong. Try changing to a different model in Settings.',
      details: msg,
      category: 'config',
      retryable: false,
      action: 'Go to Settings and select a different model',
    };
  }

  // ── Fallback ──────────────────────────────────────
  return {
    title: 'Something Went Wrong',
    message: msg.length > 200 ? msg.slice(0, 200) + '…' : msg,
    details: msg.length > 200 ? msg : undefined,
    category: 'unknown',
    retryable: true,
    action: 'Try again or check Settings',
  };
}
