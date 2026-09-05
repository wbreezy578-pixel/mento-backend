import { describe, expect, it } from 'vitest';
import { AIRequestGatewayError, buildBoundAIRequestId, buildInitialAIRequestId, requireClientAIRequestId } from './aiSecurityGateway';
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

  it('derives a stable pre-conversation operation identity for first-message sends', () => {
    const first = buildInitialAIRequestId({
      userId: 'user-a',
      feature: 'chat',
      clientRequestId: 'operation-12345',
      operationType: 'chat.send',
      payloadHash: 'payload-a',
    });
    const replay = buildInitialAIRequestId({
      userId: 'user-a',
      feature: 'chat',
      clientRequestId: 'operation-12345',
      operationType: 'chat.send',
      payloadHash: 'payload-a',
    });
    const conflict = buildInitialAIRequestId({
      userId: 'user-a',
      feature: 'chat',
      clientRequestId: 'operation-12345',
      operationType: 'chat.send',
      payloadHash: 'payload-b',
    });

    expect(first).toBe(replay);
    expect(first).not.toBe(conflict);
  });

  it('rejects malformed client operation IDs', () => {
    expect(() => buildBoundAIRequestId({
      userId: 'user-a',
      feature: 'chat',
      clientRequestId: 'short',
    })).toThrow(AIRequestGatewayError);
  });

  it('requires a client-stable operation ID for independently retriable AI requests', () => {
    const request = new Request('https://example.test/api/images/analyze', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'image-operation-123' },
    });
    expect(requireClientAIRequestId(request)).toBe('image-operation-123');
    expect(requireClientAIRequestId(request, 'body-operation-456')).toBe('body-operation-456');

    const missing = new Request('https://example.test/api/images/analyze', { method: 'POST' });
    expect(() => requireClientAIRequestId(missing)).toThrow(AIRequestGatewayError);
    try {
      requireClientAIRequestId(missing);
    } catch (error) {
      expect((error as AIRequestGatewayError).body).toEqual(expect.objectContaining({ code: 'missing_operation_id' }));
    }
  });

  it('rejects malformed client-stable operation IDs before provider execution', () => {
    const request = new Request('https://example.test/api/images/analyze', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'bad id' },
    });
    expect(() => requireClientAIRequestId(request)).toThrow(AIRequestGatewayError);
  });

  it('requires stable operation IDs at every billable Normal Chat HTTP entry point', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    for (const route of [
      'app/api/chat/route.ts',
      'app/api/chat/stream/route.ts',
      'app/api/chat/message/regenerate/route.ts',
      'app/api/images/analyze/route.ts',
    ]) {
      const code = fs.readFileSync(path.join(process.cwd(), route), 'utf8');
      expect(code).toContain('requireClientAIRequestId(req,');
    }
  });

  it('leaves product quotas to the billing plan unless an abuse ceiling is explicitly configured', () => {
    expect(resolveDailyMessageAbuseLimit(undefined)).toBe(-1);
    expect(resolveDailyMessageAbuseLimit('500')).toBe(500);
    expect(resolveDailyMessageAbuseLimit('invalid')).toBe(-1);
  });
});
