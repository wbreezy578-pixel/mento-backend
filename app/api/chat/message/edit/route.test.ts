import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUserFromRequest: vi.fn(),
  ensureCooldown: vi.fn(),
  ensureSlidingWindow: vi.fn(),
  findUnique: vi.fn(),
  findMany: vi.fn(),
  deleteMany: vi.fn(),
  updateMessage: vi.fn(),
  updateConversation: vi.fn(),
}));

vi.mock('../../../../lib/auth', () => ({ getUserFromRequest: mocks.getUserFromRequest }));
vi.mock('../../../../../lib/rateLimiter', () => ({
  ensureCooldown: mocks.ensureCooldown,
  ensureSlidingWindow: mocks.ensureSlidingWindow,
}));
vi.mock('../../../../../lib/logger', () => ({
  default: { error: vi.fn() },
}));
vi.mock('../../../../../lib/prisma', () => {
  const transactionClient = {
    conversationMessage: {
      findMany: mocks.findMany,
      deleteMany: mocks.deleteMany,
      update: mocks.updateMessage,
    },
    conversation: { update: mocks.updateConversation },
  };
  return {
    prisma: {
      conversationMessage: { findUnique: mocks.findUnique },
      $transaction: vi.fn((callback: (client: typeof transactionClient) => unknown) => callback(transactionClient)),
    },
  };
});

import { POST } from './route';

function editRequest(body: unknown) {
  return new Request('https://mento.test/api/chat/message/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('chat message editing security', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserFromRequest.mockResolvedValue({ id: 'user-a' });
    mocks.ensureCooldown.mockResolvedValue({ ok: true });
    mocks.ensureSlidingWindow.mockResolvedValue({ ok: true });
  });

  it('rejects text over the normal chat input limit before storage', async () => {
    const response = await POST(editRequest({ messageId: 'message-1', text: 'x'.repeat(8_001) }));

    expect(response.status).toBe(413);
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.ensureCooldown).not.toHaveBeenCalled();
  });

  it('normalizes text and enforces both per-user edit limits', async () => {
    const createdAt = new Date('2026-08-30T00:00:00Z');
    mocks.findUnique.mockResolvedValue({
      id: 'message-1',
      conversationId: 'conversation-1',
      role: 'user',
      createdAt,
      conversation: { userId: 'user-a', source: 'chat' },
    });
    mocks.findMany.mockResolvedValue([]);
    mocks.updateMessage.mockResolvedValue({ id: 'message-1' });
    mocks.updateConversation.mockResolvedValue({ id: 'conversation-1' });

    const response = await POST(editRequest({ messageId: ' message-1 ', text: '  cafe\u0301  ' }));

    expect(response.status).toBe(200);
    expect(mocks.ensureCooldown).toHaveBeenCalledWith('chat-edit:user-a', 1_000);
    expect(mocks.ensureSlidingWindow).toHaveBeenCalledWith('chat-edit:user-a', 30, 15 * 60, 'rl:chat-edit');
    expect(mocks.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'message-1' } }));
    expect(mocks.updateMessage).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'message-1' },
      data: expect.objectContaining({ text: 'café', content: 'café' }),
    }));
    expect(mocks.updateConversation).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        summary: null,
        summaryUpdatedAt: null,
        summaryThroughMessageId: null,
        summaryThroughCreatedAt: null,
        summaryRevision: { increment: 1 },
      }),
    }));
  });

  it('returns retry metadata when the edit window is exhausted', async () => {
    mocks.ensureSlidingWindow.mockResolvedValue({ ok: false, retryAfterSec: 42 });

    const response = await POST(editRequest({ messageId: 'message-1', text: 'updated text' }));

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('42');
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });
});
