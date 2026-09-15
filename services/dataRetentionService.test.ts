import { describe, expect, it } from 'vitest';
import { CONVERSATION_RETENTION_DAYS, getConversationRetentionCutoff } from './dataRetentionService';

describe('conversation retention', () => {
  it('uses a 365-day cutoff', () => {
    const now = new Date('2026-08-25T12:00:00.000Z');
    expect(CONVERSATION_RETENTION_DAYS).toBe(365);
    expect(getConversationRetentionCutoff(now).toISOString()).toBe('2025-08-25T12:00:00.000Z');
  });
});
