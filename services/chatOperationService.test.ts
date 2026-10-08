import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  operations: [] as any[],
  conversations: [] as any[],
  messages: [] as any[],
  sequence: 0,
}));

vi.mock('../lib/prisma', () => {
  const operationApi = {
    create: vi.fn(async ({ data }: any) => {
      const duplicate = state.operations.find((row) => row.userId === data.userId && row.clientRequestId === data.clientRequestId && row.operationType === data.operationType);
      if (duplicate) throw Object.assign(new Error('unique'), { code: 'P2002' });
      const row = { id: `op-${++state.sequence}`, ...data, conversationId: null, status: 'IN_PROGRESS', responseText: null, errorCode: null, createdAt: new Date(), updatedAt: new Date() };
      state.operations.push(row);
      return { ...row };
    }),
    findUnique: vi.fn(async ({ where }: any) => {
      const key = where.userId_clientRequestId_operationType;
      return state.operations.find((row) => key
        ? row.userId === key.userId && row.clientRequestId === key.clientRequestId && row.operationType === key.operationType
        : row.id === where.id) ?? null;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = state.operations.find((entry) => entry.id === where.id);
      Object.assign(row, data, { updatedAt: new Date() });
      return { ...row };
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const rows = state.operations.filter((row) => row.id === where.id && (!where.userId || row.userId === where.userId) && (!where.conversationId || row.conversationId === where.conversationId) && (!where.status || row.status === where.status));
      rows.forEach((row) => Object.assign(row, data, { updatedAt: new Date() }));
      return { count: rows.length };
    }),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  };
  const client: any = {
    chatOperation: operationApi,
    conversation: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `conv-${++state.sequence}`, ...data };
        state.conversations.push(row);
        return row;
      }),
    },
    conversationMessage: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `msg-${++state.sequence}`, ...data };
        state.messages.push(row);
        return row;
      }),
      findMany: vi.fn(async ({ where }: any) => state.messages.filter((row) => row.conversationId === where.conversationId && row.requestId === where.requestId)),
    },
  };
  client.$transaction = vi.fn(async (callback: any) => callback(client));
  return { prisma: client };
});

import {
  ChatOperationConflictError,
  claimInitialChatOperation,
  completeInitialChatOperation,
} from './chatOperationService';

describe('initial Normal Chat operation claims', () => {
  beforeEach(() => {
    state.operations.length = 0;
    state.conversations.length = 0;
    state.messages.length = 0;
    state.sequence = 0;
  });

  it('creates one operation, conversation and initial message', async () => {
    const result = await claimInitialChatOperation({ userId: 'user-a', clientRequestId: 'request-123', payloadHash: 'hash-a', initialMessage: 'Hello' });
    expect(result.kind).toBe('claimed');
    expect(state.operations).toHaveLength(1);
    expect(state.conversations).toHaveLength(1);
    expect(state.messages).toHaveLength(1);
  });

  it('serializes simultaneous identical claims across the unique operation key', async () => {
    const results = await Promise.all([
      claimInitialChatOperation({ userId: 'user-a', clientRequestId: 'request-123', payloadHash: 'hash-a', initialMessage: 'Hello' }),
      claimInitialChatOperation({ userId: 'user-a', clientRequestId: 'request-123', payloadHash: 'hash-a', initialMessage: 'Hello' }),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(['claimed', 'in_progress']);
    expect(new Set(results.map((result) => result.conversationId)).size).toBe(1);
    expect(state.conversations).toHaveLength(1);
  });

  it('allows only the atomic winner to reach Gemini and accounting', async () => {
    let geminiCalls = 0;
    let usageReservations = 0;
    const execute = async () => {
      const claim = await claimInitialChatOperation({ userId: 'user-a', clientRequestId: 'request-123', payloadHash: 'hash-a', initialMessage: 'Hello' });
      if (claim.kind === 'claimed') {
        usageReservations += 1;
        geminiCalls += 1;
      }
      return claim;
    };

    await Promise.all([execute(), execute(), execute()]);

    expect(geminiCalls).toBe(1);
    expect(usageReservations).toBe(1);
    expect(state.conversations).toHaveLength(1);
  });

  it('recovers the durable response after response loss without creating again', async () => {
    const first = await claimInitialChatOperation({ userId: 'user-a', clientRequestId: 'request-123', payloadHash: 'hash-a', initialMessage: 'Hello' });
    state.messages.push({ id: 'assistant-1', conversationId: first.conversationId, requestId: 'request-123', role: 'assistant', status: 'completed', content: 'Recovered answer' });
    await completeInitialChatOperation({ operationId: first.operationId, userId: 'user-a', conversationId: first.conversationId, responseText: 'Recovered answer' });

    const replay = await claimInitialChatOperation({ userId: 'user-a', clientRequestId: 'request-123', payloadHash: 'hash-a', initialMessage: 'Hello' });
    expect(replay).toMatchObject({ kind: 'completed', conversationId: first.conversationId, responseText: 'Recovered answer' });
    expect(state.conversations).toHaveLength(1);
    expect(state.operations).toHaveLength(1);
  });

  it('retains completed recovery state across a simulated server reload', async () => {
    const first = await claimInitialChatOperation({ userId: 'user-a', clientRequestId: 'request-123', payloadHash: 'hash-a', initialMessage: 'Hello' });
    state.messages.push({ id: 'assistant-1', conversationId: first.conversationId, requestId: 'request-123', role: 'assistant', status: 'completed', content: 'Durable answer' });
    await completeInitialChatOperation({ operationId: first.operationId, userId: 'user-a', conversationId: first.conversationId, responseText: 'Durable answer' });
    vi.resetModules();
    const reloaded = await import('./chatOperationService');

    const recovered = await reloaded.claimInitialChatOperation({ userId: 'user-a', clientRequestId: 'request-123', payloadHash: 'hash-a', initialMessage: 'Hello' });

    expect(recovered).toMatchObject({ kind: 'completed', conversationId: first.conversationId, responseText: 'Durable answer' });
    expect(state.conversations).toHaveLength(1);
  });

  it('rejects reuse of an operation ID with a different canonical payload', async () => {
    await claimInitialChatOperation({ userId: 'user-a', clientRequestId: 'request-123', payloadHash: 'hash-a', initialMessage: 'Hello' });
    await expect(claimInitialChatOperation({ userId: 'user-a', clientRequestId: 'request-123', payloadHash: 'hash-b', initialMessage: 'Changed' }))
      .rejects.toBeInstanceOf(ChatOperationConflictError);
    expect(state.conversations).toHaveLength(1);
  });

  it('scopes recovery to the authenticated user', async () => {
    const first = await claimInitialChatOperation({ userId: 'user-a', clientRequestId: 'request-123', payloadHash: 'hash-a', initialMessage: 'Hello' });
    const other = await claimInitialChatOperation({ userId: 'user-b', clientRequestId: 'request-123', payloadHash: 'hash-a', initialMessage: 'Hello' });
    expect(other.conversationId).not.toBe(first.conversationId);
    expect(state.conversations).toHaveLength(2);
  });
});
