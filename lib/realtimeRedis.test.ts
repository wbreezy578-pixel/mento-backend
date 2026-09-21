import { beforeEach, describe, expect, it, vi } from 'vitest';

const evalCommand = vi.fn();
const hset = vi.fn();
const expire = vi.fn();
const ping = vi.fn();

vi.mock('./env', () => ({
  getRedisUrl: () => 'rediss://redis.example.test:6380',
}));

vi.mock('./redisClient', () => ({
  createRedisClient: () => ({
    on: vi.fn(),
    eval: evalCommand,
    hset,
    expire,
    ping,
    quit: vi.fn(),
  }),
}));

describe('Live Tutor Redis leases', () => {
  beforeEach(() => {
    evalCommand.mockReset();
    hset.mockReset();
    expire.mockReset();
    ping.mockReset();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('REDIS_STARTUP_RETRY_DELAY_MS', '0');
  });

  it('places owner and session keys in the same Redis Cluster hash slot', async () => {
    evalCommand.mockResolvedValue(1);
    const { acquireVoiceLease, releaseVoiceLease } = await import('./realtimeRedis');

    await acquireVoiceLease('stream-123', 'owner-1', { status: 'active' });
    await releaseVoiceLease('stream-123', 'owner-1');

    expect(evalCommand).toHaveBeenLastCalledWith(
      expect.any(String),
      2,
      'voice:{stream-123}:owner',
      'voice:{stream-123}:session',
      'owner-1',
    );
  });

  it('releases an owner-safe lease when session metadata cannot be persisted', async () => {
    evalCommand.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    hset.mockRejectedValueOnce(new Error('Redis metadata unavailable'));
    const { acquireVoiceLease } = await import('./realtimeRedis');

    await expect(acquireVoiceLease('stream-456', 'owner-2', { status: 'active' }))
      .rejects.toThrow('Redis metadata unavailable');

    expect(evalCommand).toHaveBeenLastCalledWith(
      expect.any(String),
      2,
      'voice:{stream-456}:owner',
      'voice:{stream-456}:session',
      'owner-2',
    );
  });

  it('keeps a LiveKit session lease in one Redis Cluster hash slot', async () => {
    evalCommand.mockResolvedValue(1);
    const { acquireLiveTutorSessionLease, releaseLiveTutorSessionLease } = await import('./realtimeRedis');

    await acquireLiveTutorSessionLease('livekit-stream-123', { userId: 'user-1', status: 'active' });
    await releaseLiveTutorSessionLease('livekit-stream-123');

    expect(evalCommand).toHaveBeenLastCalledWith(
      expect.any(String),
      2,
      'live-tutor:{livekit-stream-123}:owner',
      'live-tutor:{livekit-stream-123}:session',
      'livekit:livekit-stream-123',
    );
  });

  it('keeps the HTTP server available when production realtime Redis is unavailable', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    ping.mockRejectedValue(new Error('Redis unavailable'));
    const { assertRealtimeRedisReadyForProduction } = await import('./realtimeRedis');

    await expect(assertRealtimeRedisReadyForProduction()).resolves.toBeUndefined();
  });

  it('allows production startup when realtime Redis is healthy', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    ping.mockResolvedValue('PONG');
    const { assertRealtimeRedisReadyForProduction } = await import('./realtimeRedis');

    await expect(assertRealtimeRedisReadyForProduction()).resolves.toBeUndefined();
  });

  it('does not require realtime Redis outside production', async () => {
    const { assertRealtimeRedisReadyForProduction } = await import('./realtimeRedis');

    await expect(assertRealtimeRedisReadyForProduction()).resolves.toBeUndefined();
    expect(ping).not.toHaveBeenCalled();
  });
});
