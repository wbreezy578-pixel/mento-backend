import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const client = {
    status: 'connecting',
    defineCommand: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    slidingWindowAtomic: vi.fn(),
  };
  return {
    client,
    createRedisClient: vi.fn(() => client),
    getRedisUrl: vi.fn(() => 'rediss://default:token@example.upstash.io:6379'),
    inc: vi.fn(),
  };
});

vi.mock('./env', () => ({ getRedisUrl: mocks.getRedisUrl }));
vi.mock('./redisClient', () => ({ createRedisClient: mocks.createRedisClient }));
vi.mock('./metrics', () => ({
  rateLimitAllowed: { inc: mocks.inc },
  rateLimitDenied: { inc: mocks.inc },
  rateLimitHits: { inc: mocks.inc },
}));
vi.mock('./logger', () => ({ default: { warn: vi.fn() } }));

describe('rate limiter Redis readiness', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.client.status = 'connecting';
    mocks.client.defineCommand.mockImplementation((name: string) => {
      (mocks.client as Record<string, unknown>)[name] = mocks.client.slidingWindowAtomic;
    });
    mocks.client.slidingWindowAtomic.mockResolvedValue(['1', String(Date.now())]);
    process.env.REQUIRE_RATE_LIMIT_REDIS = 'true';
    process.env.NODE_ENV = 'test';
  });

  it('waits for an initial Redis connection before issuing the atomic command', async () => {
    let ready: (() => void) | undefined;
    mocks.client.once.mockImplementation((event: string, callback: () => void) => {
      if (event === 'ready') ready = callback;
      return mocks.client;
    });

    const { ensureSlidingWindow } = await import('./rateLimiter');
    const decision = ensureSlidingWindow('login:ip:test', 10, 60);

    expect(mocks.client.slidingWindowAtomic).not.toHaveBeenCalled();
    mocks.client.status = 'ready';
    ready?.();

    await expect(decision).resolves.toEqual({ ok: true });
    expect(mocks.client.slidingWindowAtomic).toHaveBeenCalledTimes(1);
  });
});
