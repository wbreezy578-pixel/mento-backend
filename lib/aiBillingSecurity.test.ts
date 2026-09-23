import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AIRequestGatewayError, buildBoundAIRequestId, buildInitialAIRequestId, requireClientAIRequestId } from './aiSecurityGateway';
import { resolveDailyMessageAbuseLimit } from './rate-limiter';
import { BillingTransactionQueueTimeoutError, createKeyedTransactionQueue } from '../services/billingTransactionQueue';

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

  it('does not recursively reserve usage while rolling back a missing reservation', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'services/billingService.ts'), 'utf8');
    const start = source.indexOf('export async function rollbackUsage(');
    const rollbackBody = source.slice(start);

    expect(rollbackBody).not.toContain('return reserveUsage(');
    expect(rollbackBody).toContain('No usage reservation existed to roll back.');
  });

  it('does not recursively reserve usage while finalizing a missing reservation', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'services/billingService.ts'), 'utf8');
    const start = source.indexOf('export async function finalizeUsage(');
    const end = source.indexOf('\nasync function reconcileNonCompletedUsage(', start);
    const body = source.slice(start, end);
    const transactionStart = body.indexOf('return await runTransactionWithRetries');
    const transactionBody = body.slice(transactionStart);

    expect(body).toContain('const existingBeforeFinalize = await prisma.usageLog.findUnique');
    expect(transactionBody).not.toContain('return reserveUsage(');
  });

  it('serializes concurrent billing work for one user', async () => {
    const queue = createKeyedTransactionQueue(1_000);
    let active = 0;
    let maximumActive = 0;
    let mutations = 0;
    const run = async () => {
      const release = await queue.acquire('user-1');
      try {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        mutations += 1;
        await Promise.resolve();
        active -= 1;
      } finally {
        release();
      }
    };

    await Promise.all([run(), run(), run()]);
    expect(maximumActive).toBe(1);
    expect(mutations).toBe(3);
  });

  it('removes a timed-out waiter and allows the next billing operation', async () => {
    vi.useFakeTimers();
    try {
      const queue = createKeyedTransactionQueue(50);
      const releaseFirst = await queue.acquire('user-1');
      const blocked = queue.acquire('user-1');
      const rejection = expect(blocked).rejects.toBeInstanceOf(BillingTransactionQueueTimeoutError);

      await vi.advanceTimersByTimeAsync(50);
      await rejection;
      releaseFirst();

      const releaseNext = await queue.acquire('user-1');
      releaseNext();
    } finally {
      vi.useRealTimers();
    }
  });
});
