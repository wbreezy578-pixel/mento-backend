import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const tx = {
    conversation: { create: vi.fn() },
    conversationMessage: { create: vi.fn() },
  };
  return {
    tx,
    prisma: { $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) },
  };
});

vi.mock('../lib/prisma', () => ({ prisma: mocks.prisma }));

import { saveChatToDatabase } from './chatService';

describe('durable standalone image-analysis chat persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tx.conversation.create.mockResolvedValue({ id: 'conversation-1' });
    mocks.tx.conversationMessage.create
      .mockResolvedValueOnce({ id: 'user-message' })
      .mockResolvedValueOnce({ id: 'assistant-message' });
  });

  it('atomically creates a chat-scoped conversation and two completed messages', async () => {
    const result = await saveChatToDatabase('user-1', 'Analyze this graph', 'The graph rises.', 'request-1');
    expect(mocks.prisma.$transaction).toHaveBeenCalledOnce();
    expect(mocks.tx.conversation.create).toHaveBeenCalledWith({
      data: { userId: 'user-1', source: 'chat', title: 'Image Analysis' },
      select: { id: true },
    });
    expect(mocks.tx.conversationMessage.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({ role: 'user', status: 'completed', requestId: 'request-1' }),
      select: { id: true },
    });
    expect(mocks.tx.conversationMessage.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({ role: 'assistant', status: 'completed', requestId: 'request-1' }),
      select: { id: true },
    });
    expect(result).toEqual({ conversationId: 'conversation-1', userMessageId: 'user-message', assistantMessageId: 'assistant-message' });
  });

  it('propagates assistant persistence failure so the surrounding transaction rolls back', async () => {
    mocks.tx.conversationMessage.create
      .mockReset()
      .mockResolvedValueOnce({ id: 'user-message' })
      .mockRejectedValueOnce(new Error('write failed'));
    await expect(saveChatToDatabase('user-1', 'Question', 'Answer', 'request-1')).rejects.toThrow('write failed');
  });

  it('makes persistence part of the image route success contract', () => {
    const route = fs.readFileSync(path.join(process.cwd(), 'app/api/images/analyze/route.ts'), 'utf8');
    const persist = route.indexOf('beforeFinalize: async (result)');
    const success = route.indexOf('return NextResponse.json({ analysis: analysisText');
    expect(persist).toBeGreaterThan(-1);
    expect(success).toBeGreaterThan(persist);
    expect(route).toContain('requireClientAIRequestId');
    expect(route).toContain("operationType: 'image.analyze'");
    expect(route).toContain('payloadHash: operationPayloadHash');
    expect(route).not.toContain('Failed to persist image analysis to conversation');
  });
});
