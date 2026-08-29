import { describe, expect, it } from 'vitest';
import { AIRequestGatewayError, buildBoundAIRequestId } from './aiSecurityGateway';
import { resolveDailyMessageAbuseLimit } from './rate-limiter';

describe('AI billing operation security', () => {
  it('binds a client operation to its user, conversation, operation and payload', () => {
    const base = {
      userId: 'user-a',
      feature: 'chat',
      clientRequestId: 'operation-12345',
      metadata: { operationType: 'chat.send', conversationId: 'conversation-a', payloadHash: 'payload-a' },
    };
    const requestId = buildBoundAIRequestId(base);

    expect(buildBoundAIRequestId(base)).toBe(requestId);
    expect(buildBoundAIRequestId({ ...base, userId: 'user-b' })).not.toBe(requestId);
    expect(buildBoundAIRequestId({ ...base, metadata: { ...base.metadata, conversationId: 'conversation-b' } })).not.toBe(requestId);
    expect(buildBoundAIRequestId({ ...base, metadata: { ...base.metadata, payloadHash: 'payload-b' } })).not.toBe(requestId);
    expect(buildBoundAIRequestId({ ...base, metadata: { ...base.metadata, operationType: 'chat.regenerate' } })).not.toBe(requestId);
  });

  it('rejects malformed client operation IDs', () => {
    expect(() => buildBoundAIRequestId({
      userId: 'user-a',
      feature: 'chat',
      clientRequestId: 'short',
    })).toThrow(AIRequestGatewayError);
  });

  it('leaves product quotas to the billing plan unless an abuse ceiling is explicitly configured', () => {
    expect(resolveDailyMessageAbuseLimit(undefined)).toBe(-1);
    expect(resolveDailyMessageAbuseLimit('500')).toBe(500);
    expect(resolveDailyMessageAbuseLimit('invalid')).toBe(-1);
  });
});
