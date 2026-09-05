import logger from './logger';
import { sanitizeForLogging } from './sanitize';
import { incrementProviderRetry, observeProviderLatency, recordProviderCircuitState, recordProviderFailure, recordProviderRequest, recordProviderSuccess } from './metricsClient';

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  retryableStatusCodes?: number[];
  shouldRetry?: (error: unknown) => boolean;
  provider?: string;
}

export interface CircuitBreakerState {
  failures: number;
  openedAt?: number;
  halfOpen: boolean;
}

export type CircuitBreakerStateName = 'closed' | 'open' | 'half-open';
export type ProviderName = 'gemini' | 'simli' | 'supabase' | 'mpesa' | 'redis' | 'payment:mpesa' | 'payment:paddle';

interface ProviderRetryConfig {
  timeoutMs: number;
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  resetTimeoutMs: number;
  failureThreshold: number;
}

const DEFAULT_RETRYABLE_STATUS_CODES = [408, 429, 500, 502, 503, 504];
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_RESET_TIMEOUT_MS = 30000;

const circuitBreakers = new Map<string, CircuitBreakerState>();
const providerRetryDefaults: Record<ProviderName, ProviderRetryConfig> = {
  gemini: { timeoutMs: 30000, retries: 2, baseDelayMs: 500, maxDelayMs: 2000, resetTimeoutMs: 30000, failureThreshold: 5 },
  simli: { timeoutMs: 8000, retries: 2, baseDelayMs: 400, maxDelayMs: 1600, resetTimeoutMs: 30000, failureThreshold: 3 },
  supabase: { timeoutMs: 8000, retries: 2, baseDelayMs: 300, maxDelayMs: 1500, resetTimeoutMs: 30000, failureThreshold: 3 },
  mpesa: { timeoutMs: 10000, retries: 2, baseDelayMs: 400, maxDelayMs: 1600, resetTimeoutMs: 60000, failureThreshold: 3 },
  redis: { timeoutMs: 2000, retries: 1, baseDelayMs: 200, maxDelayMs: 1000, resetTimeoutMs: 30000, failureThreshold: 3 },
  'payment:mpesa': { timeoutMs: 10000, retries: 2, baseDelayMs: 400, maxDelayMs: 1600, resetTimeoutMs: 60000, failureThreshold: 3 },
  'payment:paddle': { timeoutMs: 10000, retries: 2, baseDelayMs: 400, maxDelayMs: 1600, resetTimeoutMs: 60000, failureThreshold: 3 },
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getProviderRetryConfig(provider: string): ProviderRetryConfig {
  const normalized = provider.toLowerCase() as ProviderName;
  const defaults = providerRetryDefaults[normalized] ?? providerRetryDefaults.gemini;
  return {
    ...defaults,
    timeoutMs: readNumberEnv(`MENTO_${normalized.toUpperCase()}_TIMEOUT_MS`, defaults.timeoutMs),
    retries: readNumberEnv(`MENTO_${normalized.toUpperCase()}_RETRIES`, defaults.retries),
    baseDelayMs: readNumberEnv(`MENTO_${normalized.toUpperCase()}_BASE_DELAY_MS`, defaults.baseDelayMs),
    maxDelayMs: readNumberEnv(`MENTO_${normalized.toUpperCase()}_MAX_DELAY_MS`, defaults.maxDelayMs),
    resetTimeoutMs: readNumberEnv(`MENTO_${normalized.toUpperCase()}_RESET_TIMEOUT_MS`, defaults.resetTimeoutMs),
    failureThreshold: readNumberEnv(`MENTO_${normalized.toUpperCase()}_FAILURE_THRESHOLD`, defaults.failureThreshold),
  };
}

export { sanitizeForLogging } from './sanitize';

export function getProviderTimeoutMs(provider: string, fallback = DEFAULT_TIMEOUT_MS): number {
  return getProviderRetryConfig(provider).timeoutMs || fallback;
}

export function getProviderRetryOptions(provider: string, overrides: Partial<RetryOptions> = {}): RetryOptions {
  const config = getProviderRetryConfig(provider);
  return {
    retries: config.retries,
    baseDelayMs: config.baseDelayMs,
    maxDelayMs: config.maxDelayMs,
    timeoutMs: config.timeoutMs,
    ...overrides,
    provider,
  };
}

export function getClientErrorMessage(message?: string, fallback = 'Service is temporarily unavailable. Please try again shortly.') {
  const cleaned = typeof message === 'string' ? message.trim() : '';
  if (!cleaned) return fallback;
  if (/api key|token|secret|password|database|connection string|environment variable/i.test(cleaned)) {
    return fallback;
  }
  return cleaned;
}

function getErrorStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

function isAuthOrValidationError(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status && [400, 401, 403, 404, 422].includes(status)) {
    return true;
  }
  const message = error instanceof Error && error.message ? error.message : '';
  return /invalid|unauthorized|forbidden|validation|bad request/i.test(message);
}

export async function retryWithBackoff<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 2000;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const provider = options.provider;
  const shouldRetry = options.shouldRetry ?? ((error: unknown) => {
    const status = getErrorStatus(error);
    return status === undefined || DEFAULT_RETRYABLE_STATUS_CODES.includes(status);
  });

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs);
      });
      const startedAt = Date.now();
      const result = await Promise.race([operation(), timeoutPromise]);
      if (provider) {
        observeProviderLatency(provider, Date.now() - startedAt);
      }
      return result;
    } catch (error) {
      lastError = error;
      const isTimeoutError = error instanceof Error && /timed out|aborted|abort/i.test(error.message);
      const retryable = shouldRetry(error) && !isAuthOrValidationError(error);
      if (!retryable || attempt === retries || isTimeoutError) {
        if (provider) {
          recordProviderFailure(provider);
          recordProviderRequest(provider, 'failed');
        }
        throw error;
      }
      const delay = Math.min(baseDelayMs * (attempt + 1), maxDelayMs) * (0.7 + Math.random() * 0.6);
      incrementProviderRetry(provider ?? 'unknown');
      logger.warn('Retrying after transient failure', {
        provider,
        attempt: attempt + 1,
        delayMs: Math.round(delay),
        error: sanitizeForLogging(error),
      });
      await sleep(delay);
    }
  }
  throw lastError;
}

export function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit | undefined, timeoutMs = DEFAULT_TIMEOUT_MS, provider?: string): Promise<Response> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  const request = fetch(input, { ...init, signal: controller.signal });

  return request.finally(() => {
    clearTimeout(timeoutHandle);
    if (provider) {
      observeProviderLatency(provider, Date.now() - startedAt);
    }
  });
}

function getCircuitBreakerStateName(state: CircuitBreakerState, resetTimeoutMs: number): CircuitBreakerStateName {
  if (!state.openedAt) {
    return state.halfOpen ? 'half-open' : 'closed';
  }
  if (Date.now() - state.openedAt >= resetTimeoutMs) {
    state.openedAt = undefined;
    state.halfOpen = true;
    return 'half-open';
  }
  return 'open';
}

export function getCircuitBreaker(name: string, threshold = DEFAULT_FAILURE_THRESHOLD, resetTimeoutMs = DEFAULT_RESET_TIMEOUT_MS) {
  const existing = circuitBreakers.get(name);
  const publishState = (state: CircuitBreakerState) => {
    recordProviderCircuitState(name, getCircuitBreakerStateName(state, resetTimeoutMs));
  };

  if (existing) {
    return {
      state: existing,
      getState: () => getCircuitBreakerStateName(existing, resetTimeoutMs),
      isOpen: () => getCircuitBreakerStateName(existing, resetTimeoutMs) === 'open',
      recordSuccess: () => {
        existing.failures = 0;
        existing.openedAt = undefined;
        existing.halfOpen = false;
        publishState(existing);
      },
      recordFailure: () => {
        if (existing.halfOpen) {
          existing.failures = threshold;
          existing.openedAt = Date.now();
          existing.halfOpen = false;
          publishState(existing);
          return;
        }
        existing.failures += 1;
        if (existing.failures >= threshold) {
          existing.openedAt = Date.now();
          existing.halfOpen = false;
        }
        publishState(existing);
      },
    };
  }

  const state: CircuitBreakerState = { failures: 0, halfOpen: false };
  circuitBreakers.set(name, state);
  publishState(state);

  return {
    state,
    getState: () => getCircuitBreakerStateName(state, resetTimeoutMs),
    isOpen: () => getCircuitBreakerStateName(state, resetTimeoutMs) === 'open',
    recordSuccess: () => {
      state.failures = 0;
      state.openedAt = undefined;
      state.halfOpen = false;
      publishState(state);
      recordProviderSuccess(name);
    },
    recordFailure: () => {
      if (state.halfOpen) {
        state.failures = threshold;
        state.openedAt = Date.now();
        state.halfOpen = false;
        publishState(state);
        recordProviderFailure(name);
        return;
      }
      state.failures += 1;
      if (state.failures >= threshold) {
        state.openedAt = Date.now();
        state.halfOpen = false;
      }
      publishState(state);
      recordProviderFailure(name);
    },
  };
}
