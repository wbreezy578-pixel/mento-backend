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

  it('fails closed when production realtime Redis is unavailable', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    ping.mockRejectedValue(new Error('Redis unavailable'));
    const { assertRealtimeRedisReadyForProduction } = await import('./realtimeRedis');

    await expect(assertRealtimeRedisReadyForProduction()).rejects.toThrow('refusing to start');
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
