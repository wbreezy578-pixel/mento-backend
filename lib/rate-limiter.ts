import { ensureCooldown, ensureSlidingWindow, ensureDailyQuota } from './rateLimiter';

const RATE_WINDOW_SECONDS = parseInt(process.env.RATE_WINDOW_SECONDS || '60', 10);
const RATE_LIMIT_PER_USER = parseInt(process.env.RATE_LIMIT_PER_USER || '30', 10);
// Authenticated users are still constrained individually. The higher IP ceiling
// avoids penalizing classrooms, offices, and carrier NATs that share one address.
const RATE_LIMIT_PER_IP = parseInt(process.env.RATE_LIMIT_PER_IP || '300', 10);
const MESSAGE_COOLDOWN_MS = parseInt(process.env.MESSAGE_COOLDOWN_MS || '2000', 10);
// Product quotas are enforced by the billing ledger using the user's effective
// plan. This optional global ceiling is abuse-only and is disabled by default.
export function resolveDailyMessageAbuseLimit(rawValue: string | undefined): number {
  const parsed = Number.parseInt(rawValue ?? '-1', 10);
  return Number.isFinite(parsed) ? parsed : -1;
}

const DAILY_MESSAGES_LIMIT = resolveDailyMessageAbuseLimit(process.env.DAILY_MESSAGES_LIMIT);

export async function enforceRateLimit(userId: string, ip: string) {
  // Every caller of this aggregate limiter starts a billable AI operation.
  // Never degrade to per-process counters, even in a misconfigured runtime.
  const strict = { requireDistributed: true } as const;
  // Cooldown per user
  const cd = await ensureCooldown(userId, MESSAGE_COOLDOWN_MS, strict);
  if (!cd.ok) return cd.unavailable
    ? { ok: false, status: 503, code: 'rate_limiter_unavailable', message: 'AI requests are temporarily unavailable', retryAfterSec: cd.retryAfterSec }
    : { ok: false, status: 429, code: 'rate_limit_exceeded', message: 'Slow down: message cooldown in effect', retryAfterSec: cd.retryAfterSec };

  // Sliding window per user
  const userLimit = await ensureSlidingWindow(`user:${userId}`, RATE_LIMIT_PER_USER, RATE_WINDOW_SECONDS, 'rl:window', strict);
  if (!userLimit.ok) return userLimit.unavailable
    ? { ok: false, status: 503, code: 'rate_limiter_unavailable', message: 'AI requests are temporarily unavailable', retryAfterSec: userLimit.retryAfterSec }
    : { ok: false, status: 429, code: 'rate_limit_exceeded', message: 'Rate limit exceeded for user', retryAfterSec: userLimit.retryAfterSec };

  // Sliding window per IP
  const ipLimit = await ensureSlidingWindow(`ip:${ip}`, RATE_LIMIT_PER_IP, RATE_WINDOW_SECONDS, 'rl:window', strict);
  if (!ipLimit.ok) return ipLimit.unavailable
    ? { ok: false, status: 503, code: 'rate_limiter_unavailable', message: 'AI requests are temporarily unavailable', retryAfterSec: ipLimit.retryAfterSec }
    : { ok: false, status: 429, code: 'rate_limit_exceeded', message: 'Rate limit exceeded for IP', retryAfterSec: ipLimit.retryAfterSec };

  // Daily quota
  if (DAILY_MESSAGES_LIMIT >= 0) {
    const daily = await ensureDailyQuota(userId, DAILY_MESSAGES_LIMIT, strict);
    if (!daily.ok) return daily.unavailable
      ? { ok: false, status: 503, code: 'rate_limiter_unavailable', message: 'AI requests are temporarily unavailable', retryAfterSec: 5 }
      : { ok: false, status: 429, code: 'rate_limit_exceeded', message: 'Daily message quota exceeded' };
  }

  return { ok: true };
}

export default enforceRateLimit;
