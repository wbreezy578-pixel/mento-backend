import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('rate-limit failure safety', () => {
  it('checks conversation-delete limits before acquiring its generation lock', () => {
    const route = source('app/api/conversations/[id]/route.ts');
    const rateLimitIndex = route.indexOf("enforceChatEndpointRateLimit(user.id, 'delete-conversation')");
    const lockIndex = route.indexOf('acquireAIGenerationLock(conversationId, lockOwner)');

    expect(rateLimitIndex).toBeGreaterThan(-1);
    expect(lockIndex).toBeGreaterThan(rateLimitIndex);
  });

  it('requires distributed rate limiting for every aggregate AI limit', () => {
    const limiter = source('lib/rate-limiter.ts');

    expect(limiter).toContain('const strict = { requireDistributed: true } as const');
    expect(limiter).toContain("status: 503, code: 'rate_limiter_unavailable'");
    expect(limiter).toContain('ensureCooldown(userId, MESSAGE_COOLDOWN_MS, strict)');
    expect(limiter).toContain("RATE_WINDOW_SECONDS, 'rl:window', strict");

    const primitiveLimiter = source('lib/rateLimiter.ts');
    expect(primitiveLimiter).toContain('`${type}_unavailable`');
  });

  it('reports required Redis failures as readiness degradation', () => {
    const readiness = source('app/api/ready/route.ts');
    const policy = source('app/api/ready/healthStatus.ts');

    expect(readiness).toContain('checkRealtimeRedisHealth()');
    expect(policy).toContain('[checks.database, checks.redis]');
  });
});
