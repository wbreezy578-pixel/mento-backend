import { describe, expect, it } from 'vitest';
import { getChatRateLimitPolicy } from './chatRateLimits';
import { resolveConversationSource } from './conversationSource';

describe('normal chat policy boundaries', () => {
  it('defaults conversation listings to normal chat', () => {
    expect(resolveConversationSource(undefined)).toBe('chat');
    expect(resolveConversationSource(null)).toBe('chat');
    expect(resolveConversationSource('anything-else')).toBe('chat');
    expect(resolveConversationSource('live_tutor')).toBe('live_tutor');
  });

  it('applies finite limits to every secondary chat operation', () => {
    const operations = [
      'start', 'history', 'list', 'edit', 'delete-message', 'feedback',
      'delete-conversation', 'rename', 'pin',
    ] as const;
    for (const operation of operations) {
      const policy = getChatRateLimitPolicy(operation);
      expect(policy.limit).toBeGreaterThan(0);
      expect(policy.windowSeconds).toBeGreaterThan(0);
    }
  });
});
