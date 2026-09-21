import { getRedisUrl } from './env';
import { LIVE_TUTOR_MAX_SESSION_SECONDS } from './liveTutorLimits';
import logger from './logger';
import { createRedisClient, type MentoRedisClient } from './redisClient';

const REALTIME_LEASE_TTL_SECONDS = 30;
const LIVE_TUTOR_SESSION_LEASE_TTL_SECONDS = 120;
// These are deliberately conservative defaults for Simli's current Free plan.
// Raising them is a backend configuration change made only after the matching
// Simli plan is active; mobile clients never control provider capacity.
const DEFAULT_MAX_CONCURRENT_LIVE_TUTOR_SESSIONS = 1;
const DEFAULT_MAX_CONCURRENT_AVATAR_STARTS = 1;
const LIVE_TUTOR_CAPACITY_SESSION_TTL_SECONDS = LIVE_TUTOR_MAX_SESSION_SECONDS + LIVE_TUTOR_SESSION_LEASE_TTL_SECONDS;
const LIVE_TUTOR_AVATAR_START_TTL_SECONDS = 180;
const REDIS_STARTUP_ATTEMPTS = 4;
const REDIS_STARTUP_RETRY_DELAYS_MS = [750, 1_500, 3_000];
const isBuild = process.env.MENTO_BUILD === '1';
const redisUrl = getRedisUrl();
const requireRedis = process.env.REQUIRE_REALTIME_REDIS === 'true';

let redis: MentoRedisClient | null = null;

if (redisUrl && !isBuild) {
  redis = createRedisClient(redisUrl);
  redis.on('error', (error) => {
    logger.warn('[RealtimeRedis] Redis connection error', {
      message: error.message,
      category: 'live_tutor_realtime_redis',
    });
  });
}

function leaseKey(streamId: string): string {
  return `voice:{${streamId}}:owner`;
}

function sessionKey(streamId: string): string {
  return `voice:{${streamId}}:session`;
}

function liveTutorSessionLeaseKey(streamId: string): string {
  return `live-tutor:{${streamId}}:owner`;
}

function liveTutorSessionStateKey(streamId: string): string {
  return `live-tutor:{${streamId}}:session`;
}

function liveTutorCapacityKey(kind: 'sessions' | 'avatar-starts'): string {
  // The shared hash tag keeps the key cluster-safe while allowing every Cloud
  // Run replica to enforce one global Simli admission limit.
  return `live-tutor:capacity:{global}:${kind}`;
}

function configuredPositiveInteger(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getLiveTutorCapacityConfig(): {
  maxConcurrentSessions: number;
  maxConcurrentAvatarStarts: number;
} {
  return {
    maxConcurrentSessions: configuredPositiveInteger(
      'LIVE_TUTOR_MAX_CONCURRENT_SESSIONS',
      DEFAULT_MAX_CONCURRENT_LIVE_TUTOR_SESSIONS,
    ),
    maxConcurrentAvatarStarts: configuredPositiveInteger(
      'LIVE_TUTOR_MAX_CONCURRENT_AVATAR_STARTS',
      DEFAULT_MAX_CONCURRENT_AVATAR_STARTS,
    ),
  };
}

async function reserveLiveTutorCapacitySlot(
  kind: 'sessions' | 'avatar-starts',
  member: string,
  maximum: number,
  ttlSeconds: number,
): Promise<boolean> {
  const client = assertRedisAvailable();
  if (!client) return true;
  const now = Date.now();
  const reserved = await client.eval(
    "local now = tonumber(ARGV[1]); local expiresAt = tonumber(ARGV[2]); local maximum = tonumber(ARGV[3]); local member = ARGV[4]; redis.call('zremrangebyscore', KEYS[1], '-inf', now); if redis.call('zscore', KEYS[1], member) then redis.call('zadd', KEYS[1], expiresAt, member); return 1 end; if redis.call('zcard', KEYS[1]) >= maximum then return 0 end; redis.call('zadd', KEYS[1], expiresAt, member); return 1",
    1,
    liveTutorCapacityKey(kind),
    String(now),
    String(now + ttlSeconds * 1000),
    String(maximum),
    member,
  );
  return Number(reserved) === 1;
}

async function releaseLiveTutorCapacitySlot(kind: 'sessions' | 'avatar-starts', member: string): Promise<void> {
  const client = assertRedisAvailable();
  if (!client) return;
  await client.eval("return redis.call('zrem', KEYS[1], ARGV[1])", 1, liveTutorCapacityKey(kind), member);
}

export async function reserveLiveTutorSessionCapacity(requestId: string): Promise<boolean> {
  const { maxConcurrentSessions } = getLiveTutorCapacityConfig();
  return reserveLiveTutorCapacitySlot(
    'sessions',
    `pending:${requestId}`,
    maxConcurrentSessions,
    LIVE_TUTOR_CAPACITY_SESSION_TTL_SECONDS,
  );
}

export async function transferLiveTutorSessionCapacity(requestId: string, streamId: string): Promise<boolean> {
  const client = assertRedisAvailable();
  if (!client) return true;
  const now = Date.now();
  const transferred = await client.eval(
    "local now = tonumber(ARGV[1]); local expiresAt = tonumber(ARGV[2]); local pending = ARGV[3]; local active = ARGV[4]; redis.call('zremrangebyscore', KEYS[1], '-inf', now); if not redis.call('zscore', KEYS[1], pending) then return 0 end; redis.call('zrem', KEYS[1], pending); redis.call('zadd', KEYS[1], expiresAt, active); return 1",
    1,
    liveTutorCapacityKey('sessions'),
    String(now),
    String(now + LIVE_TUTOR_CAPACITY_SESSION_TTL_SECONDS * 1000),
    `pending:${requestId}`,
    `stream:${streamId}`,
  );
  return Number(transferred) === 1;
}

export async function refreshLiveTutorSessionCapacity(streamId: string): Promise<boolean> {
  const client = assertRedisAvailable();
  if (!client) return true;
  const now = Date.now();
  const refreshed = await client.eval(
    "local now = tonumber(ARGV[1]); local expiresAt = tonumber(ARGV[2]); redis.call('zremrangebyscore', KEYS[1], '-inf', now); if not redis.call('zscore', KEYS[1], ARGV[3]) then return 0 end; redis.call('zadd', KEYS[1], expiresAt, ARGV[3]); return 1",
    1,
    liveTutorCapacityKey('sessions'),
    String(now),
    String(now + LIVE_TUTOR_CAPACITY_SESSION_TTL_SECONDS * 1000),
    `stream:${streamId}`,
  );
  return Number(refreshed) === 1;
}

export async function releaseLiveTutorSessionCapacity(requestId: string): Promise<void> {
  await releaseLiveTutorCapacitySlot('sessions', `pending:${requestId}`);
}

export async function releaseActiveLiveTutorSessionCapacity(streamId: string): Promise<void> {
  await releaseLiveTutorCapacitySlot('sessions', `stream:${streamId}`);
}

export async function reserveLiveTutorAvatarStartCapacity(requestId: string): Promise<boolean> {
  const { maxConcurrentAvatarStarts } = getLiveTutorCapacityConfig();
  return reserveLiveTutorCapacitySlot(
    'avatar-starts',
    `request:${requestId}`,
    maxConcurrentAvatarStarts,
    LIVE_TUTOR_AVATAR_START_TTL_SECONDS,
  );
}

export async function releaseLiveTutorAvatarStartCapacity(requestId: string): Promise<void> {
  await releaseLiveTutorCapacitySlot('avatar-starts', `request:${requestId}`);
}

export function getLiveTutorSessionLeaseOwner(streamId: string): string {
  return `livekit:${streamId}`;
}

function assertRedisAvailable(): MentoRedisClient | null {
  if (!redis && requireRedis) {
    throw new Error('Realtime Redis is required but REDIS_URL is not configured.');
  }
  return redis;
}

export async function acquireVoiceLease(
  streamId: string,
  ownerId: string,
  fields: Record<string, string>,
): Promise<boolean> {
  const client = assertRedisAvailable();
  if (!client) return true;

  const acquired = await client.eval(
    "local current = redis.call('get', KEYS[1]); if not current then redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[2]); return 1 elseif current == ARGV[1] then redis.call('expire', KEYS[1], ARGV[2]); return 1 else return 0 end",
    1,
    leaseKey(streamId),
    ownerId,
    String(REALTIME_LEASE_TTL_SECONDS),
  );
  if (Number(acquired) !== 1) return false;

  try {
    await client.hset(sessionKey(streamId), {
      ...fields,
      ownerId,
      acquiredAt: new Date().toISOString(),
    });
    await client.expire(sessionKey(streamId), REALTIME_LEASE_TTL_SECONDS);
  } catch (error) {
    // Do not leave a successful owner-key write blocking reconnects after the
    // accompanying session metadata write failed. The Lua release remains
    // owner-safe, so it cannot delete a lease that another process acquired.
    await releaseVoiceLease(streamId, ownerId).catch(() => undefined);
    throw error;
  }
  return true;
}

export async function refreshVoiceLease(
  streamId: string,
  ownerId: string,
  fields: Record<string, string> = {},
): Promise<boolean> {
  const client = assertRedisAvailable();
  if (!client) return true;

  const leaseResult = await client.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end",
    1,
    leaseKey(streamId),
    ownerId,
    String(REALTIME_LEASE_TTL_SECONDS),
  );
  if (Number(leaseResult) !== 1) return false;

  if (Object.keys(fields).length > 0) {
    await client.hset(sessionKey(streamId), fields);
  }
  await client.expire(sessionKey(streamId), REALTIME_LEASE_TTL_SECONDS);
  return true;
}

export async function releaseVoiceLease(streamId: string, ownerId: string): Promise<void> {
  const client = assertRedisAvailable();
  if (!client) return;

  await client.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('del', KEYS[1]); redis.call('del', KEYS[2]); return 1 else return 0 end",
    2,
    leaseKey(streamId),
    sessionKey(streamId),
    ownerId,
  );
}

export function getRealtimeRedisStatus(): { configured: boolean; required: boolean } {
  return { configured: Boolean(redisUrl), required: requireRedis || process.env.NODE_ENV === 'production' };
}

export async function assertRealtimeRedisReadyForProduction(): Promise<void> {
  // Redis coordinates Live Tutor sessions, but it must never decide whether the
  // whole HTTP API can boot. A transient DNS/TLS failure previously kept Cloud
  // Run from listening on PORT, taking sign-in, Chat, Learn and billing down
  // alongside Live Tutor. Keep the probe/retries for observability, then let
  // the server start; voice operations still fail closed through
  // assertRedisAvailable when REQUIRE_REALTIME_REDIS is enabled.
  if (process.env.NODE_ENV !== 'production') return;

  const status = getRealtimeRedisStatus();
  if (!status.configured) {
    logger.error('[RealtimeRedis] Redis is not configured; Live Tutor voice will be unavailable until it is restored', {
      category: 'realtime_redis_startup_degraded',
      required: status.required,
    });
    return;
  }

  for (let attempt = 1; attempt <= REDIS_STARTUP_ATTEMPTS; attempt += 1) {
    const health = await checkRealtimeRedisHealth();
    if (health === 'ok') return;

    if (attempt < REDIS_STARTUP_ATTEMPTS) {
      const configuredDelay = Number(process.env.REDIS_STARTUP_RETRY_DELAY_MS);
      const delayMs = Number.isFinite(configuredDelay) && configuredDelay >= 0
        ? configuredDelay
        : REDIS_STARTUP_RETRY_DELAYS_MS[attempt - 1] ?? 3_000;
      logger.warn('[RealtimeRedis] Redis unavailable during production startup; retrying', {
        attempt,
        maxAttempts: REDIS_STARTUP_ATTEMPTS,
        delayMs,
        category: 'realtime_redis_startup_retry',
      });
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  logger.error('[RealtimeRedis] Redis is unavailable after startup retries; starting the HTTP API in degraded mode', {
    category: 'realtime_redis_startup_degraded',
    required: status.required,
  });
}

/**
 * Coordinates an active LiveKit room across Cloud Run replicas. The owner is a
 * logical LiveKit session id, rather than a process id, so any replica may
 * safely renew its liveness record while LiveKit owns the media session.
 */
export async function acquireLiveTutorSessionLease(
  streamId: string,
  fields: Record<string, string>,
): Promise<boolean> {
  const client = assertRedisAvailable();
  if (!client) return true;
  const ownerId = getLiveTutorSessionLeaseOwner(streamId);
  const acquired = await client.eval(
    "local current = redis.call('get', KEYS[1]); if not current then redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[2]); return 1 elseif current == ARGV[1] then redis.call('expire', KEYS[1], ARGV[2]); return 1 else return 0 end",
    1,
    liveTutorSessionLeaseKey(streamId),
    ownerId,
    String(LIVE_TUTOR_SESSION_LEASE_TTL_SECONDS),
  );
  if (Number(acquired) !== 1) return false;
  try {
    await client.hset(liveTutorSessionStateKey(streamId), {
      ...fields,
      ownerId,
      lastHeartbeatAt: new Date().toISOString(),
    });
    await client.expire(liveTutorSessionStateKey(streamId), LIVE_TUTOR_SESSION_LEASE_TTL_SECONDS);
  } catch (error) {
    await releaseLiveTutorSessionLease(streamId).catch(() => undefined);
    throw error;
  }
  return true;
}

export async function refreshLiveTutorSessionLease(
  streamId: string,
  fields: Record<string, string> = {},
): Promise<boolean> {
  const client = assertRedisAvailable();
  if (!client) return true;
  const ownerId = getLiveTutorSessionLeaseOwner(streamId);
  const refreshed = await client.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end",
    1,
    liveTutorSessionLeaseKey(streamId),
    ownerId,
    String(LIVE_TUTOR_SESSION_LEASE_TTL_SECONDS),
  );
  if (Number(refreshed) !== 1) return false;
  if (Object.keys(fields).length > 0) await client.hset(liveTutorSessionStateKey(streamId), fields);
  await client.expire(liveTutorSessionStateKey(streamId), LIVE_TUTOR_SESSION_LEASE_TTL_SECONDS);
  return true;
}

export async function releaseLiveTutorSessionLease(streamId: string): Promise<void> {
  const client = assertRedisAvailable();
  if (!client) return;
  await client.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('del', KEYS[1]); redis.call('del', KEYS[2]); return 1 else return 0 end",
    2,
    liveTutorSessionLeaseKey(streamId),
    liveTutorSessionStateKey(streamId),
    getLiveTutorSessionLeaseOwner(streamId),
  );
}

export async function checkRealtimeRedisHealth(): Promise<'ok' | 'not_configured' | 'fail'> {
  try {
    const client = assertRedisAvailable();
    if (!client) {
      logger.warn('[RealtimeRedis] Redis health check skipped because it is not configured', {
        configured: false,
        required: requireRedis || process.env.NODE_ENV === 'production',
        category: 'realtime_redis_health',
      });
      return 'not_configured';
    }

    const pong = await client.ping();
    if (pong !== 'PONG') {
      logger.warn('[RealtimeRedis] Redis health check failed', {
        configured: true,
        pong,
        required: requireRedis || process.env.NODE_ENV === 'production',
        category: 'realtime_redis_health',
      });
      return 'fail';
    }

    return 'ok';
  } catch (error) {
    logger.warn('[RealtimeRedis] Redis health check failed', {
      errorName: error instanceof Error ? error.name : 'unknown',
      required: requireRedis || process.env.NODE_ENV === 'production',
      category: 'realtime_redis_health',
    });
    return 'fail';
  }
}

export async function shutdownRealtimeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}
