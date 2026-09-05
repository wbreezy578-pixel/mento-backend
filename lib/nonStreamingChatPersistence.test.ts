import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const tx = {
    conversationMessage: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    conversation: { update: vi.fn() },
  };
  return {
    tx,
    prisma: {
      $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
    },
  };
});

vi.mock('./prisma', () => ({ prisma: mocks.prisma }));

import { persistCompletedChatExchange } from './conversationDb';

function source(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('non-streaming Normal Chat persistence contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tx.conversationMessage.findUnique.mockResolvedValue(null);
    mocks.tx.conversationMessage.create
      .mockResolvedValueOnce({ id: 'user-message' })
      .mockResolvedValueOnce({ id: 'assistant-message', status: 'completed' });
    mocks.tx.conversation.update.mockResolvedValue({ id: 'conversation-1' });
  });

  it('atomically persists one user message and one completed assistant message', async () => {
    const result = await persistCompletedChatExchange({
      conversationId: 'conversation-1',
      userId: 'user-1',
      requestId: 'request-1',
      userText: 'Question',
      assistantText: 'Answer',
      userMessageAlreadySaved: false,
    });

    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.tx.conversationMessage.create).toHaveBeenCalledTimes(2);
    expect(mocks.tx.conversationMessage.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ role: 'assistant', status: 'completed', requestId: 'request-1' }),
    });
    expect(result).toMatchObject({ id: 'assistant-message' });
  });

  it('does not duplicate messages when the same exchange already exists', async () => {
    mocks.tx.conversationMessage.findUnique.mockImplementation(async (query) => {
      const role = query.where.conversationId_requestId_role.role;
      return role === 'user' ? { id: 'user-message' } : { id: 'assistant-message', status: 'completed' };
    });

    await persistCompletedChatExchange({
      conversationId: 'conversation-1',
      userId: 'user-1',
      requestId: 'request-1',
      userText: 'Question',
      assistantText: 'Answer',
      userMessageAlreadySaved: false,
    });

    expect(mocks.tx.conversationMessage.create).not.toHaveBeenCalled();
  });

  it('rejects when assistant persistence fails instead of reporting success', async () => {
    mocks.tx.conversationMessage.create
      .mockReset()
      .mockResolvedValueOnce({ id: 'user-message' })
      .mockRejectedValueOnce(new Error('database write failed'));

    await expect(persistCompletedChatExchange({
      conversationId: 'conversation-1',
      userId: 'user-1',
      requestId: 'request-1',
      userText: 'Question',
      assistantText: 'Answer',
      userMessageAlreadySaved: false,
    })).rejects.toThrow('database write failed');
  });

  it('persists before finalization and returns a stable safe failure contract', () => {
    const route = source('app/api/chat/route.ts');
    const gateway = source('lib/aiSecurityGateway.ts');
    const persistence = route.indexOf('await persistCompletedChatExchange({');
    const success = route.indexOf('return NextResponse.json({ result: result.result, conversationId }');
    const finalize = gateway.indexOf('await finalizeAIUsage({');
    expect(persistence).toBeGreaterThan(-1);
    expect(success).toBeGreaterThan(persistence);
    expect(gateway.indexOf('await options.beforeFinalize?.(result)')).toBeLessThan(finalize);
    expect(gateway).toContain("code: 'chat_persistence_failed'");
    expect(gateway).toContain('reconcilePersistenceFailureUsage({');
  });

  it('retains provider expense without consuming completed allowance', () => {
    const billing = source('services/billingService.ts');
    expect(billing).toContain("reconcileNonCompletedUsage(input, 'persistence_failed')");
    expect(billing).toContain('providerCostUSD,');
    expect(billing).toContain('userChargeUSD: 0');
    expect(billing).toContain('success: false');
    expect(billing).toContain('isNonCompletedGenerationOutcome(existing.metadata)');
    expect(source('prisma/schema.prisma')).toContain('@@unique([provider, requestId])');
  });

  it('always releases the generation lock and leaves streaming persistence ordered', () => {
    const route = source('app/api/chat/route.ts');
    expect(route).toContain('finally {');
    expect(route).toContain('await releaseAIGenerationLock(');

    const streaming = source('app/api/chat/stream/route.ts');
    const persistence = streaming.indexOf("data: { content: finalAssistantText, text: finalAssistantText, status: 'completed' }");
    const done = streaming.indexOf("type: 'done'", persistence);
    expect(persistence).toBeGreaterThan(-1);
    expect(done).toBeGreaterThan(persistence);
  });
});
