/**
 * Global Rate Limiter — enforces per-provider request rate limits.
 *
 * Every API call in the app goes through `rateLimiter.acquire(provider)`
 * before firing. This proactively spaces requests to stay under each
 * provider's RPM / RPD ceiling, preventing 429 errors.
 *
 * Features:
 *  - Sliding-window RPM and RPD tracking
 *  - Proactive inter-request spacing (e.g., 4.1s for Gemini Free's 15 RPM)
 *  - Adaptive backoff when 429s are reported downstream
 *  - Console logging for DevTools visibility
 */

import { AI_PROVIDERS, GEMINI_TIER_INFO, type AIProviderType, type GeminiTier } from '../types';

// ── Per-provider rate limit config ──────────────────────────

export interface ProviderRateLimits {
  /** Requests per minute — 0 means unlimited */
  rpm: number;
  /** Requests per day — 0 means unlimited */
  rpd: number;
  /** Minimum milliseconds between consecutive requests (derived from RPM) */
  minIntervalMs: number;
}

/** Known rate limits for each provider */
const PROVIDER_LIMITS: Record<AIProviderType, ProviderRateLimits> = {
  'gemini-free': { rpm: 15, rpd: 1500, minIntervalMs: 4100 },  // Free tier: 15 RPM, 1500 RPD
  'gemini-paid': { rpm: 15, rpd: 1500, minIntervalMs: 4100 },   // Also starts at free defaults; updated by setGeminiTier()
  'xai':         { rpm: 480, rpd: 0, minIntervalMs: 0 },      // xAI docs: 480 RPM on listed Grok models
  'huggingface': { rpm: 10, rpd: 0, minIntervalMs: 6100 },    // conservative
  'openai':      { rpm: 500, rpd: 0, minIntervalMs: 0 },
  'anthropic':   { rpm: 50, rpd: 0, minIntervalMs: 0 },
  'qwen':        { rpm: 60, rpd: 0, minIntervalMs: 0 },
  'deepseek':    { rpm: 60, rpd: 0, minIntervalMs: 0 },
  'minimax':     { rpm: 60, rpd: 0, minIntervalMs: 0 },
};

// ── Internal state ──────────────────────────────────────────

interface ProviderState {
  /** Timestamps of recent requests (sliding window) */
  requestTimestamps: number[];
  /** Timestamp of last completed request */
  lastRequestAt: number;
  /** Adaptive multiplier — increases on 429, decreases on success */
  backoffMultiplier: number;
  /** Number of consecutive 429 errors */
  consecutive429s: number;
  /** Whether this provider is considered exhausted for the day */
  exhaustedUntil: number;
}

// ── Singleton Rate Limiter ──────────────────────────────────

class RateLimiter {
  private state: Map<AIProviderType, ProviderState> = new Map();
  private pendingQueues: Map<AIProviderType, Array<() => void>> = new Map();
  private currentTier: GeminiTier = 'free';

  constructor() {
    // Initialize state for all providers
    for (const type of Object.keys(PROVIDER_LIMITS) as AIProviderType[]) {
      this.state.set(type, {
        requestTimestamps: [],
        lastRequestAt: 0,
        backoffMultiplier: 1.0,
        consecutive429s: 0,
        exhaustedUntil: 0,
      });
    }
  }

  /**
   * Update Gemini rate limits based on the user's billing tier.
   * Call this when the tier setting changes or on app init.
   */
  setGeminiTier(tier: GeminiTier): void {
    this.currentTier = tier;
    const tierInfo = GEMINI_TIER_INFO[tier];
    const rpm = tierInfo.estimatedRpm;
    const rpd = tierInfo.estimatedRpd;
    // Derive spacing: (60s / RPM) + 100ms safety, but cap at 0 for high RPM
    const minIntervalMs = rpm >= 100 ? Math.ceil(60_000 / rpm) + 10 : Math.ceil(60_000 / rpm) + 100;

    PROVIDER_LIMITS['gemini-free'] = { rpm, rpd, minIntervalMs };
    PROVIDER_LIMITS['gemini-paid'] = { rpm, rpd, minIntervalMs };

    console.log(`[RateLimiter] Gemini tier set to ${tier}: ${rpm} RPM, ${rpd} RPD, ${minIntervalMs}ms spacing`);
  }

  /** Get the currently configured Gemini tier */
  getCurrentTier(): GeminiTier {
    return this.currentTier;
  }

  /**
   * Wait until it's safe to make a request to the given provider.
   * Resolves when the request can proceed.
   */
  async acquire(provider: AIProviderType): Promise<void> {
    const limits = PROVIDER_LIMITS[provider] ?? { rpm: 0, rpd: 0, minIntervalMs: 0 };
    const state = this.getState(provider);
    const now = Date.now();

    // Check if provider is exhausted (daily limit hit)
    if (state.exhaustedUntil > now) {
      const waitMs = state.exhaustedUntil - now;
      console.warn(`[RateLimiter] ${provider} is exhausted. Wait ${Math.round(waitMs / 1000)}s or switch providers.`);
      throw new ProviderExhaustedError(provider, waitMs);
    }

    // Clean up old timestamps (older than 1 minute for RPM, 24h for RPD)
    this.cleanTimestamps(provider);

    // ── RPD check ──
    if (limits.rpd > 0) {
      const dayStart = now - 24 * 60 * 60 * 1000;
      const dayCount = state.requestTimestamps.filter(t => t > dayStart).length;
      if (dayCount >= limits.rpd) {
        state.exhaustedUntil = dayStart + 24 * 60 * 60 * 1000;
        console.warn(`[RateLimiter] ${provider} daily limit (${limits.rpd}) reached.`);
        throw new ProviderExhaustedError(provider, state.exhaustedUntil - now);
      }
    }

    // ── RPM check ──
    if (limits.rpm > 0) {
      const minuteStart = now - 60_000;
      const minuteCount = state.requestTimestamps.filter(t => t > minuteStart).length;
      if (minuteCount >= limits.rpm) {
        // Find when the oldest request in the window will expire
        const oldest = state.requestTimestamps.filter(t => t > minuteStart).sort((a, b) => a - b)[0];
        const waitMs = oldest + 60_000 - now + 100; // +100ms safety margin
        console.log(`[RateLimiter] ${provider} RPM limit (${limits.rpm}/min). Waiting ${Math.round(waitMs / 1000)}s…`);
        await this.sleep(waitMs);
      }
    }

    // ── Minimum interval spacing ──
    const effectiveInterval = limits.minIntervalMs * state.backoffMultiplier;
    if (effectiveInterval > 0 && state.lastRequestAt > 0) {
      const elapsed = now - state.lastRequestAt;
      if (elapsed < effectiveInterval) {
        const waitMs = effectiveInterval - elapsed;
        console.log(`[RateLimiter] ${provider} spacing: ${Math.round(waitMs)}ms (interval=${Math.round(effectiveInterval)}ms, backoff=${state.backoffMultiplier.toFixed(1)}x)`);
        await this.sleep(waitMs);
      }
    }

    // Record this request
    const requestTime = Date.now();
    state.requestTimestamps.push(requestTime);
    state.lastRequestAt = requestTime;
  }

  /**
   * Report a successful request — decreases adaptive backoff.
   */
  reportSuccess(provider: AIProviderType): void {
    const state = this.getState(provider);
    state.consecutive429s = 0;
    // Gradually reduce backoff multiplier toward 1.0
    if (state.backoffMultiplier > 1.0) {
      state.backoffMultiplier = Math.max(1.0, state.backoffMultiplier * 0.8);
      console.log(`[RateLimiter] ${provider} backoff reduced to ${state.backoffMultiplier.toFixed(1)}x`);
    }
  }

  /**
   * Report a 429 / rate-limit error — increases adaptive backoff.
   */
  reportThrottled(provider: AIProviderType): void {
    const state = this.getState(provider);
    state.consecutive429s++;
    // Exponential backoff: 1.5x → 2.25x → 3.375x, capped at 4x
    state.backoffMultiplier = Math.min(4.0, state.backoffMultiplier * 1.5);
    console.warn(
      `[RateLimiter] ${provider} hit 429 (#${state.consecutive429s}). ` +
      `Backoff now ${state.backoffMultiplier.toFixed(1)}x (interval = ${Math.round((PROVIDER_LIMITS[provider]?.minIntervalMs ?? 0) * state.backoffMultiplier)}ms)`
    );
  }

  /**
   * Get current stats for a provider (for UI display).
   */
  getStats(provider: AIProviderType): {
    rpm: number;
    rpd: number;
    currentMinuteCount: number;
    currentDayCount: number;
    backoffMultiplier: number;
    isExhausted: boolean;
    effectiveIntervalMs: number;
  } {
    const limits = PROVIDER_LIMITS[provider] ?? { rpm: 0, rpd: 0, minIntervalMs: 0 };
    const state = this.getState(provider);
    const now = Date.now();

    this.cleanTimestamps(provider);

    const minuteStart = now - 60_000;
    const dayStart = now - 24 * 60 * 60 * 1000;

    return {
      rpm: limits.rpm,
      rpd: limits.rpd,
      currentMinuteCount: state.requestTimestamps.filter(t => t > minuteStart).length,
      currentDayCount: state.requestTimestamps.filter(t => t > dayStart).length,
      backoffMultiplier: state.backoffMultiplier,
      isExhausted: state.exhaustedUntil > now,
      effectiveIntervalMs: limits.minIntervalMs * state.backoffMultiplier,
    };
  }

  /**
   * Get estimated throughput for a provider.
   */
  getEstimatedThroughput(provider: AIProviderType): {
    profilesPerHour: number;
    profilesPerDay: number;
    bottleneckReason: string;
  } {
    const limits = PROVIDER_LIMITS[provider] ?? { rpm: 0, rpd: 0, minIntervalMs: 0 };
    // Assume ~12 calls per profile in balanced mode
    const callsPerProfile = 12;

    let profilesPerHour: number;
    let profilesPerDay: number;
    let bottleneckReason: string;

    if (limits.rpm > 0) {
      profilesPerHour = Math.floor((limits.rpm * 60) / callsPerProfile);
      bottleneckReason = `${limits.rpm} RPM limit`;
    } else {
      profilesPerHour = 999;
      bottleneckReason = 'No RPM limit';
    }

    if (limits.rpd > 0) {
      const dailyProfiles = Math.floor(limits.rpd / callsPerProfile);
      const hourlyFromDaily = Math.floor(dailyProfiles / 24);
      if (hourlyFromDaily < profilesPerHour) {
        profilesPerHour = hourlyFromDaily;
        bottleneckReason = `${limits.rpd} req/day limit`;
      }
      profilesPerDay = dailyProfiles;
    } else {
      profilesPerDay = profilesPerHour * 24;
    }

    return { profilesPerHour, profilesPerDay, bottleneckReason };
  }

  // ── Private helpers ──

  private getState(provider: AIProviderType): ProviderState {
    let state = this.state.get(provider);
    if (!state) {
      state = {
        requestTimestamps: [],
        lastRequestAt: 0,
        backoffMultiplier: 1.0,
        consecutive429s: 0,
        exhaustedUntil: 0,
      };
      this.state.set(provider, state);
    }
    return state;
  }

  private cleanTimestamps(provider: AIProviderType): void {
    const state = this.getState(provider);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // Keep 24h of data
    state.requestTimestamps = state.requestTimestamps.filter(t => t > cutoff);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ── Error class for exhausted providers ─────────────────────

export class ProviderExhaustedError extends Error {
  readonly provider: AIProviderType;
  readonly waitMs: number;

  constructor(provider: AIProviderType, waitMs: number) {
    super(`Provider ${provider} is rate-limited. Wait ${Math.round(waitMs / 1000)}s or switch to another provider.`);
    this.name = 'ProviderExhaustedError';
    this.provider = provider;
    this.waitMs = waitMs;
  }
}

// ── Singleton export ────────────────────────────────────────

export const rateLimiter = new RateLimiter();
