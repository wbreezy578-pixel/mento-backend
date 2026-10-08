import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from './route';
import { NextRequest } from 'next/server';

// Mock dependencies
vi.mock('../../lib/auth', () => ({
  getUserFromRequest: vi.fn(),
}));

vi.mock('../../../lib/conversationDb', () => ({
  getUserConversations: vi.fn(),
}));

vi.mock('../../../lib/chatRateLimits', () => ({
  enforceChatEndpointRateLimit: vi.fn(),
  buildRateLimitHeaders: vi.fn(() => ({})),
}));

vi.mock('../../../lib/securityHeaders', () => ({
  buildCorsHeaders: vi.fn(() => ({})),
}));

vi.mock('../../../lib/conversationSource', () => ({
  resolveConversationSource: vi.fn((x) => x || 'chat'),
}));

import { getUserFromRequest } from '../../lib/auth';
import { getUserConversations } from '../../../lib/conversationDb';
import { enforceChatEndpointRateLimit } from '../../../lib/chatRateLimits';

describe('GET /api/conversations - lastMessage fix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the last message in a conversation, not the first', async () => {
    const mockUser = { id: 'user-1', email: 'test@example.com' };
    const mockConversations = [
      {
        id: 'conv-1',
        title: 'Test Conversation',
        pinned: false,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-02'),
        summary: null,
        summaryUpdatedAt: null,
        messages: [
          { text: 'First message - oldest' },
          { text: 'Middle message' },
          { text: 'Last message - newest' },
        ],
      },
    ];

    (getUserFromRequest as any).mockResolvedValue(mockUser);
    (getUserConversations as any).mockResolvedValue(mockConversations);
    (enforceChatEndpointRateLimit as any).mockResolvedValue({ ok: true });

    const request = new NextRequest('http://localhost:3000/api/conversations', {
      method: 'GET',
    });

    const response = await GET(request);
    const data = await response.json();

    // The lastMessage should be the last message, not the first
    expect(data.conversations[0].lastMessage).toBe('Last message - newest');
    expect(data.conversations[0].lastMessage).not.toBe('First message - oldest');
  });

  it('handles empty message arrays gracefully', async () => {
    const mockUser = { id: 'user-1', email: 'test@example.com' };
    const mockConversations = [
      {
        id: 'conv-1',
        title: 'Empty Conversation',
        pinned: false,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-02'),
        summary: null,
        summaryUpdatedAt: null,
        messages: [],
      },
    ];

    (getUserFromRequest as any).mockResolvedValue(mockUser);
    (getUserConversations as any).mockResolvedValue(mockConversations);
    (enforceChatEndpointRateLimit as any).mockResolvedValue({ ok: true });

    const request = new NextRequest('http://localhost:3000/api/conversations', {
      method: 'GET',
    });

    const response = await GET(request);
    const data = await response.json();

    // Empty conversations are filtered out
    expect(data.conversations).toHaveLength(0);
  });
});
