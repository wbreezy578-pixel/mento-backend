import { rateLimitAllowed, rateLimitDenied, rateLimitHits } from './metrics';
import { getRedisUrl } from './env';
import { createRedisClient, type MentoRedisClient } from './redisClient';

const REDIS_URL = getRedisUrl();
const REQUIRE_DISTRIBUTED_RATE_LIMIT = process.env.REQUIRE_RATE_LIMIT_REDIS === 'true'
  || process.env.NODE_ENV === 'production';
let redis: MentoRedisClient | null = null;

function distributedLimiterUnavailable(type: 'cooldown' | 'sliding' | 'daily') {
  rateLimitDenied.inc({ type });
  rateLimitHits.inc({ type });
}

if (REDIS_URL) {
  try {
    redis = createRedisClient(REDIS_URL);
    // Define a Lua-backed atomic sliding window command for accuracy under concurrency
    try {
      redis.defineCommand('slidingWindowAtomic', {
        numberOfKeys: 1,
        lua: `
          -- ARGV: nowTs, minTs, windowMs, member, limit
          local key = KEYS[1]
          local nowTs = tonumber(ARGV[1])
          local minTs = tonumber(ARGV[2])
          local windowMs = tonumber(ARGV[3])
          local member = ARGV[4]
          local limit = tonumber(ARGV[5])
          redis.call('ZADD', key, nowTs, member)
          redis.call('ZREMRANGEBYSCORE', key, 0, minTs)
          local cnt = redis.call('ZCARD', key)
          redis.call('PEXPIRE', key, windowMs + 1000)
          local earliest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
          local earliestTs = -1
          if earliest and #earliest >= 2 then
            earliestTs = earliest[2]
          end
          return {tostring(cnt), tostring(earliestTs)}
        `
      });
    } catch (e) {
      console.warn('Could not define slidingWindowAtomic command:', e);
    }
  } catch (err) {
    console.warn('Failed to connect to Redis for rate limiter:', err);
    redis = null;
  }
}
// Fallback in-memory stores (per-process)
const inMemoryWindows: Map<string, number[]> = new Map();
const inMemoryCooldown: Map<string, number> = new Map();

function pruneWindow(arr: number[], windowMs: number) {
  const cutoff = Date.now() - windowMs;
  while (arr.length && arr[0] < cutoff) arr.shift();
}

export async function ensureCooldown(userId: string, cooldownMs: number): Promise<{ ok: boolean; retryAfterSec?: number }> {
  if (redis) {
    const key = `rl:cooldown:${userId}`;
    try {
      const res = await redis.set(key, '1', 'PX', cooldownMs, 'NX');
      if (res === 'OK') return { ok: true };
      const ttl = await redis.pttl(key);
      rateLimitDenied.inc({ type: 'cooldown' });
      rateLimitHits.inc({ type: 'cooldown' });
      return { ok: false, retryAfterSec: Math.ceil(Math.max(ttl, 0) / 1000) };
    } catch (error) {
      console.error('Redis cooldown rate limiter failed:', error);
      if (REQUIRE_DISTRIBUTED_RATE_LIMIT) {
        distributedLimiterUnavailable('cooldown');
        return { ok: false, retryAfterSec: 5 };
      }
    }
  }

  if (REQUIRE_DISTRIBUTED_RATE_LIMIT) {
    distributedLimiterUnavailable('cooldown');
    return { ok: false, retryAfterSec: 5 };
  }

  // In-memory fallback
  const last = inMemoryCooldown.get(userId) ?? 0;
  const since = Date.now() - last;
  if (since < cooldownMs) {
    return { ok: false, retryAfterSec: Math.ceil((cooldownMs - since) / 1000) };
  }
  inMemoryCooldown.set(userId, Date.now());
  rateLimitAllowed.inc({ type: 'cooldown' });
  return { ok: true };
}

export async function ensureSlidingWindow(
  id: string,
  limit: number,
  windowSeconds: number,
  keyPrefix = 'rl:window'
): Promise<{ ok: boolean; retryAfterSec?: number }> {
  const windowMs = windowSeconds * 1000;
  const redisKey = `${keyPrefix}:${id}`;

  if (redis) {
    const nowTs = Date.now();
    const minTs = nowTs - windowMs;

    const member = `${nowTs}-${Math.random().toString(36).slice(2, 10)}`;

        try {
      const result = await (redis as MentoRedisClient & {
        slidingWindowAtomic: (
          key: string,
          nowTs: number,
          minTs: number,
          windowMs: number,
          member: string,
          limit: number
        ) => Promise<[string, string]>;
      }).slidingWindowAtomic(
        redisKey,
        nowTs,
        minTs,
        windowMs,
        member,
        limit
      );

      const count = Number(result[0] ?? 0);
      const earliestTs = Number(result[1] ?? nowTs);

      if (count > limit) {
        const retryAfterSec = Math.max(
          1,
          Math.ceil(
            Math.max(earliestTs + windowMs - nowTs, 0) / 1000
          )
        );

        rateLimitDenied.inc({ type: 'sliding' });
        rateLimitHits.inc({ type: 'sliding' });

        return {
          ok: false,
          retryAfterSec,
        };
      }

      rateLimitAllowed.inc({ type: 'sliding' });

      return { ok: true };
    } catch (error) {
      console.error(
        'Redis atomic sliding-window rate limiter failed:',
        error
      );

      if (REQUIRE_DISTRIBUTED_RATE_LIMIT) {
        distributedLimiterUnavailable('sliding');
        return { ok: false, retryAfterSec: 5 };
      }
    }
  }

  if (REQUIRE_DISTRIBUTED_RATE_LIMIT) {
    distributedLimiterUnavailable('sliding');
    return { ok: false, retryAfterSec: 5 };
  }

  // In-memory fallback
  const arr = inMemoryWindows.get(id) ?? [];

  pruneWindow(arr, windowMs);

  if (arr.length >= limit) {
    rateLimitDenied.inc({ type: 'sliding' });
    rateLimitHits.inc({ type: 'sliding' });

    const retryAfterSec = Math.max(
      1,
      Math.ceil(
        (arr[0] + windowMs - Date.now()) / 1000
      )
    );

    return {
      ok: false,
      retryAfterSec,
    };
  }

  arr.push(Date.now());
  inMemoryWindows.set(id, arr);

  rateLimitAllowed.inc({ type: 'sliding' });

  return { ok: true };
}
export async function shutdown() {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}

// Daily quota enforcement: messages per day per user
const inMemoryDaily: Map<string, { day: string; count: number }> = new Map();

function todayKeySuffix() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${(d.getUTCMonth() + 1).toString().padStart(2, '0')}-${d.getUTCDate().toString().padStart(2, '0')}`;
}

function secondsUntilTomorrowUTC() {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return Math.ceil((tomorrow.getTime() - now.getTime()) / 1000);
}

export async function ensureDailyQuota(userId: string, limitPerDay: number): Promise<{ ok: boolean; remaining?: number }> {
  const day = todayKeySuffix();
  const key = `rl:daily:${userId}:${day}`;
  if (redis) {
    try {
      const val = await redis.incr(key);
      if (val === 1) {
        await redis.expire(key, secondsUntilTomorrowUTC());
      }
      if (limitPerDay >= 0 && val > limitPerDay) {
        rateLimitDenied.inc({ type: 'daily' });
        rateLimitHits.inc({ type: 'daily' });
        return { ok: false, remaining: 0 };
      }
      rateLimitAllowed.inc({ type: 'daily' });
      return { ok: true, remaining: limitPerDay - val };
    } catch (error) {
      console.error('Redis daily quota limiter failed:', error);
      if (REQUIRE_DISTRIBUTED_RATE_LIMIT) {
        distributedLimiterUnavailable('daily');
        return { ok: false, remaining: 0 };
      }
    }
  }

  if (REQUIRE_DISTRIBUTED_RATE_LIMIT) {
    distributedLimiterUnavailable('daily');
    return { ok: false, remaining: 0 };
  }

  // In-memory fallback
  const cur = inMemoryDaily.get(userId);
  if (!cur || cur.day !== day) {
    inMemoryDaily.set(userId, { day, count: 1 });
    if (limitPerDay >= 0) {
      rateLimitAllowed.inc({ type: 'daily' });
      return { ok: true, remaining: limitPerDay - 1 };
    }
    rateLimitAllowed.inc({ type: 'daily' });
    return { ok: true, remaining: Infinity };
  }
  cur.count += 1;
  if (limitPerDay >= 0 && cur.count > limitPerDay) {
    rateLimitDenied.inc({ type: 'daily' });
    rateLimitHits.inc({ type: 'daily' });
    return { ok: false, remaining: 0 };
  }
  rateLimitAllowed.inc({ type: 'daily' });
  return { ok: true, remaining: limitPerDay - cur.count };
}

const rateLimiterApi = {
  ensureCooldown,
  ensureSlidingWindow,
  shutdown,
};

export default rateLimiterApi;
