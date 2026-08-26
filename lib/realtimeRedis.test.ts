import { beforeEach, describe, expect, it, vi } from 'vitest';

const evalCommand = vi.fn();
const hset = vi.fn();
const expire = vi.fn();

vi.mock('./env', () => ({
  getRedisUrl: () => 'rediss://redis.example.test:6380',
}));

vi.mock('./redisClient', () => ({
  createRedisClient: () => ({
    on: vi.fn(),
    eval: evalCommand,
    hset,
    expire,
    ping: vi.fn(),
    quit: vi.fn(),
  }),
}));

describe('Live Tutor Redis leases', () => {
  beforeEach(() => {
    evalCommand.mockReset();
    hset.mockReset();
    expire.mockReset();
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
});
