import { beforeEach, describe, expect, it, vi } from 'vitest';

const setCommand = vi.fn();
const evalCommand = vi.fn();

vi.mock('./env', () => ({ getRedisUrl: () => 'rediss://redis.example.test:6380' }));
vi.mock('./redisClient', () => ({
  createRedisClient: () => ({
    on: vi.fn(),
    set: setCommand,
    eval: evalCommand,
  }),
}));

describe('AI generation locks', () => {
  beforeEach(() => {
    setCommand.mockReset();
    evalCommand.mockReset();
  });

  it('acquires one Redis-backed lease per conversation', async () => {
    setCommand.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    const { acquireAIGenerationLock } = await import('./aiGenerationLock');

    await expect(acquireAIGenerationLock('conversation-1', 'owner-1')).resolves.toBe(true);
    await expect(acquireAIGenerationLock('conversation-1', 'owner-2')).resolves.toBe(false);
    expect(setCommand).toHaveBeenCalledWith(
      'ai:generation:{conversation-1}',
      'owner-1',
      'PX',
      expect.any(Number),
      'NX',
    );
  });

  it('releases a lease only when the owner matches', async () => {
    evalCommand.mockResolvedValue(1);
    const { releaseAIGenerationLock } = await import('./aiGenerationLock');

    await releaseAIGenerationLock('conversation-1', 'owner-1');
    expect(evalCommand).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('get', KEYS[1]) == ARGV[1]"),
      1,
      'ai:generation:{conversation-1}',
      'owner-1',
    );
  });
});
