import { describe, expect, it } from 'vitest';
import { NORMAL_CHAT_HISTORY_WHERE, serializeNormalChatHistoryMessage, type NormalChatHistoryRow } from './normalChatHistory';

function row(overrides: Partial<NormalChatHistoryRow> = {}): NormalChatHistoryRow {
  return {
    id: 'message-1', conversationId: 'conversation-1', role: 'assistant', status: 'completed',
    text: 'Saved answer', content: 'Saved answer', createdAt: new Date('2026-08-01T10:00:00.000Z'),
    ...overrides,
  };
}

describe('Normal Chat history contract', () => {
  it('queries only completed user and assistant messages', () => {
    expect(NORMAL_CHAT_HISTORY_WHERE).toEqual({ status: 'completed', role: { in: ['user', 'assistant'] } });
  });

  it.each(['streaming', 'failed', 'cancelled', 'pending', 'unknown'])(
    'does not serialize %s records as normal history',
    (status) => expect(serializeNormalChatHistoryMessage(row({ status }))).toBeNull(),
  );

  it('does not serialize anomalous roles as normal history', () => {
    expect(serializeNormalChatHistoryMessage(row({ role: 'system' }))).toBeNull();
    expect(serializeNormalChatHistoryMessage(row({ role: 'developer' }))).toBeNull();
  });

  it('returns completed content with explicit status and authoritative timestamp', () => {
    const createdAt = new Date('2026-08-01T10:00:00.123Z');
    expect(serializeNormalChatHistoryMessage(row({ createdAt }))).toMatchObject({
      id: 'message-1', role: 'assistant', status: 'completed', text: 'Saved answer', createdAt,
    });
  });
});
