import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

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
    vi.useRealTimers();
    vi.resetModules();
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

  it('an old operation cannot remove a newer operation owner', async () => {
    let authoritativeOwner = 'owner-b';
    evalCommand.mockImplementation(async (script: string, _keys: number, _key: string, claimedOwner: string) => {
      if (script.includes("redis.call('del'")) {
        if (authoritativeOwner === claimedOwner) authoritativeOwner = '';
        return authoritativeOwner ? 0 : 1;
      }
      return authoritativeOwner === claimedOwner ? 1 : 0;
    });
    const { releaseAIGenerationLock } = await import('./aiGenerationLock');

    await releaseAIGenerationLock('conversation-1', 'owner-a');

    expect(authoritativeOwner).toBe('owner-b');
  });

  it('renews a lease only while the same owner still holds it', async () => {
    evalCommand.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const { renewAIGenerationLock } = await import('./aiGenerationLock');

    await expect(renewAIGenerationLock('conversation-1', 'owner-1')).resolves.toBe(true);
    await expect(renewAIGenerationLock('conversation-1', 'owner-2')).resolves.toBe(false);
    expect(evalCommand).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("redis.call('pexpire', KEYS[1], ARGV[2])"),
      1,
      'ai:generation:{conversation-1}',
      'owner-1',
      expect.any(Number),
    );
  });

  it('keeps a long generation exclusively owned through periodic renewal', async () => {
    vi.useFakeTimers();
    evalCommand.mockResolvedValue(1);
    const { startAIGenerationLockHeartbeat } = await import('./aiGenerationLock');
    const lease = startAIGenerationLockHeartbeat('conversation-long', 'owner-1');

    await vi.advanceTimersByTimeAsync(125_000);

    expect(lease.signal.aborted).toBe(false);
    expect(evalCommand.mock.calls.filter(([script]) => String(script).includes('pexpire')).length).toBeGreaterThanOrEqual(4);
    lease.stop();
  });

  it('fails closed and aborts protected work when ownership is lost', async () => {
    vi.useFakeTimers();
    evalCommand.mockResolvedValue(0);
    const { startAIGenerationLockHeartbeat, AIGenerationLeaseLostError } = await import('./aiGenerationLock');
    const lease = startAIGenerationLockHeartbeat('conversation-lost', 'owner-1');

    await vi.advanceTimersByTimeAsync(30_000);

    expect(lease.signal.aborted).toBe(true);
    await expect(lease.assertOwned()).rejects.toBeInstanceOf(AIGenerationLeaseLostError);
  });

  it('fails closed when Redis renewal is unavailable', async () => {
    vi.useFakeTimers();
    evalCommand.mockRejectedValue(new Error('redis unavailable'));
    const { startAIGenerationLockHeartbeat } = await import('./aiGenerationLock');
    const lease = startAIGenerationLockHeartbeat('conversation-redis', 'owner-1');

    await vi.advanceTimersByTimeAsync(30_000);

    expect(lease.signal.aborted).toBe(true);
  });

  it('stopping after cancellation prevents future renewal', async () => {
    vi.useFakeTimers();
    evalCommand.mockResolvedValue(1);
    const { startAIGenerationLockHeartbeat } = await import('./aiGenerationLock');
    const lease = startAIGenerationLockHeartbeat('conversation-cancelled', 'owner-1');
    lease.stop();

    await vi.advanceTimersByTimeAsync(125_000);

    expect(evalCommand).not.toHaveBeenCalled();
    expect(lease.signal.aborted).toBe(false);
  });

  it('enforces the hard operation deadline even while renewals succeed', async () => {
    vi.useFakeTimers();
    vi.stubEnv('AI_GENERATION_LOCK_TTL_MS', '30000');
    vi.stubEnv('AI_GENERATION_LOCK_RENEW_MS', '5000');
    vi.stubEnv('AI_GENERATION_OPERATION_DEADLINE_MS', '40000');
    vi.resetModules();
    evalCommand.mockResolvedValue(1);
    const { startAIGenerationLockHeartbeat, AIGenerationDeadlineError } = await import('./aiGenerationLock');
    const lease = startAIGenerationLockHeartbeat('conversation-deadline', 'owner-1');

    await vi.advanceTimersByTimeAsync(40_000);

    expect(lease.signal.aborted).toBe(true);
    await expect(lease.assertOwned()).rejects.toBeInstanceOf(AIGenerationDeadlineError);
    vi.unstubAllEnvs();
  });

  it('guards every Normal Chat provider and persistence boundary with the lease', () => {
    for (const relativePath of [
      'app/api/chat/route.ts',
      'app/api/chat/stream/route.ts',
      'app/api/chat/message/regenerate/route.ts',
    ]) {
      const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
      expect(source).toContain('const generationLease = startAIGenerationLockHeartbeat(');
      expect(source).toContain('await generationLease.assertOwned();');
      expect(source).toContain('return reportProviderAttempt(model);');
      expect(source).toContain('beforeFinalize: async');
      expect(source).toContain('generationLease.stop();');
    }
    expect(fs.readFileSync(path.join(process.cwd(), 'app/api/chat/stream/route.ts'), 'utf8'))
      .toContain('AbortSignal.any([req.signal, generationLease.signal])');
  });
});
