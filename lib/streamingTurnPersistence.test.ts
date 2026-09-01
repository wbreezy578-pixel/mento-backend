import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type StoredMessage = {
  id: string;
  conversationId: string;
  userId: string;
  requestId: string;
  role: string;
  status: string;
  content: string;
  text: string;
};

const state = vi.hoisted(() => ({
  conversation: { id: 'conversation-1', userId: 'user-1', source: 'chat', title: null as string | null, updatedAt: new Date(0) },
  messages: [] as StoredMessage[],
  analytics: [] as Array<Record<string, unknown>>,
  failAt: null as null | 'user' | 'assistant' | 'analytics' | 'metadata',
  nextId: 1,
}));

function cloneState() {
  return {
    conversation: { ...state.conversation, updatedAt: new Date(state.conversation.updatedAt) },
    messages: state.messages.map((message) => ({ ...message })),
    analytics: state.analytics.map((event) => ({ ...event })),
    nextId: state.nextId,
  };
}

function restoreState(snapshot: ReturnType<typeof cloneState>) {
  state.conversation = snapshot.conversation;
  state.messages = snapshot.messages;
  state.analytics = snapshot.analytics;
  state.nextId = snapshot.nextId;
}

const tx = {
  conversation: {
    findFirst: vi.fn(async ({ where }: any) => (
      state.conversation.id === where.id
      && state.conversation.userId === where.userId
      && state.conversation.source === where.source
        ? { id: state.conversation.id, title: state.conversation.title }
        : null
    )),
    update: vi.fn(async ({ data }: any) => {
      if ('updatedAt' in data && state.failAt === 'metadata') throw new Error('metadata failed');
      Object.assign(state.conversation, data);
      return { ...state.conversation };
    }),
  },
  conversationMessage: {
    findUnique: vi.fn(async ({ where }: any) => {
      const key = where.conversationId_requestId_role;
      const message = state.messages.find((item) => (
        item.conversationId === key.conversationId
        && item.requestId === key.requestId
        && item.role === key.role
      ));
      return message ? { id: message.id, status: message.status } : null;
    }),
    findFirst: vi.fn(async ({ where }: any) => {
      const message = state.messages.find((item) => (
        item.conversationId === where.conversationId
        && item.role === where.role
        && item.content === where.content
        && item.requestId !== where.NOT?.requestId
      ));
      return message ? { id: message.id } : null;
    }),
    create: vi.fn(async ({ data }: any) => {
      if (state.failAt === data.role) throw new Error(`${data.role} failed`);
      const message = { ...data, id: `message-${state.nextId++}` } as StoredMessage;
      state.messages.push(message);
      return { id: message.id, status: message.status };
    }),
  },
  chatAnalyticsEvent: {
    create: vi.fn(async ({ data }: any) => {
      if (state.failAt === 'analytics') throw new Error('analytics failed');
      state.analytics.push({ ...data });
      return data;
    }),
  },
};

vi.mock('./prisma', () => ({
  prisma: {
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
      const snapshot = cloneState();
      try {
        return await callback(tx);
      } catch (error) {
        restoreState(snapshot);
        throw error;
      }
    }),
  },
}));

vi.mock('./logger', () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { initializeStreamingTurn } from './conversationDb';

const input = {
  conversationId: 'conversation-1',
  userId: 'user-1',
  requestId: 'request-1',
  userText: 'Explain fractions',
  titleText: 'Explain fractions',
  userMessageAlreadySaved: false,
  repeatedPromptHash: 'prompt-hash',
};

beforeEach(() => {
  state.conversation = { id: 'conversation-1', userId: 'user-1', source: 'chat', title: null, updatedAt: new Date(0) };
  state.messages = [];
  state.analytics = [];
  state.failAt = null;
  state.nextId = 1;
  vi.clearAllMocks();
});

describe('atomic streaming-turn persistence', () => {
  it('commits one user message, one streaming placeholder, and conversation metadata', async () => {
    const result = await initializeStreamingTurn(input);

    expect(result).toEqual({ userMessageId: 'message-1', assistantMessageId: 'message-2' });
    expect(state.messages.map(({ role, status }) => ({ role, status }))).toEqual([
      { role: 'user', status: 'completed' },
      { role: 'assistant', status: 'streaming' },
    ]);
    expect(state.conversation.title).toBe('Explain fractions');
    expect(state.conversation.updatedAt.getTime()).toBeGreaterThan(0);
  });

  it.each(['user', 'assistant', 'metadata'] as const)(
    'rolls back the entire new turn when the %s write fails',
    async (failAt) => {
      state.failAt = failAt;
      await expect(initializeStreamingTurn(input)).rejects.toThrow();

      expect(state.messages).toEqual([]);
      expect(state.analytics).toEqual([]);
      expect(state.conversation.title).toBeNull();
      expect(state.conversation.updatedAt).toEqual(new Date(0));
    },
  );

  it('rolls back messages and metadata when repeated-prompt telemetry fails', async () => {
    state.messages.push({
      id: 'earlier', conversationId: 'conversation-1', userId: 'user-1', requestId: 'earlier-request',
      role: 'user', status: 'completed', content: input.userText, text: input.userText,
    });
    state.failAt = 'analytics';

    await expect(initializeStreamingTurn(input)).rejects.toThrow('analytics failed');
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].id).toBe('earlier');
    expect(state.conversation.title).toBeNull();
  });

  it('is idempotent for an exact replay and creates no duplicate turn records', async () => {
    const first = await initializeStreamingTurn(input);
    const second = await initializeStreamingTurn(input);

    expect(second).toEqual(first);
    expect(state.messages).toHaveLength(2);
  });

  it('uses the ChatOperation user message for a new conversation and creates only the placeholder', async () => {
    state.messages.push({
      id: 'initial-user', conversationId: 'conversation-1', userId: 'user-1', requestId: 'request-1',
      role: 'user', status: 'completed', content: input.userText, text: input.userText,
    });

    const result = await initializeStreamingTurn({ ...input, userMessageAlreadySaved: true });
    expect(result.userMessageId).toBe('initial-user');
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1].role).toBe('assistant');
  });

  it('does not create a placeholder if the claimed initial user message is missing', async () => {
    await expect(initializeStreamingTurn({ ...input, userMessageAlreadySaved: true }))
      .rejects.toThrow('initial user message is missing');
    expect(state.messages).toEqual([]);
  });

  it('rejects a conversation not owned by the authenticated user without writes', async () => {
    await expect(initializeStreamingTurn({ ...input, userId: 'user-2' })).rejects.toThrow('Conversation not found');
    expect(state.messages).toEqual([]);
    expect(state.conversation.title).toBeNull();
  });

  it('keeps the provider boundary after committed initialization', () => {
    const route = readFileSync(new URL('../app/api/chat/stream/route.ts', import.meta.url), 'utf8');
    const initialization = route.indexOf('await initializeStreamingTurn({');
    const providerExecution = route.indexOf('await executeAIRequest({');
    const initializationFailureReturn = route.indexOf('return;', initialization);

    expect(initialization).toBeGreaterThan(-1);
    expect(providerExecution).toBeGreaterThan(initialization);
    expect(initializationFailureReturn).toBeGreaterThan(initialization);
    expect(initializationFailureReturn).toBeLessThan(providerExecution);
  });

  it('checks cancellation before initializing any streaming-turn state', () => {
    const route = readFileSync(new URL('../app/api/chat/stream/route.ts', import.meta.url), 'utf8');
    const cancellationGuard = route.indexOf('if (generationSignal.aborted) {');
    const initialization = route.indexOf('await initializeStreamingTurn({');

    expect(cancellationGuard).toBeGreaterThan(-1);
    expect(cancellationGuard).toBeLessThan(initialization);
  });
});
