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

describe('GET /api/conversations - Drawer Performance Fix Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('messages[0] access pattern with take: 1', () => {
    it('correctly accesses newest message using messages[0]', async () => {
      const mockUser = { id: 'user-1', email: 'test@example.com' };
      // With take: 1, orderBy: { createdAt: 'desc' }, messages array has exactly 1 item
      // That item is the newest message
      const mockConversations = [
        {
          id: 'conv-1',
          title: 'Conversation 1',
          pinned: false,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-10'),
          summary: null,
          summaryUpdatedAt: null,
          messages: [{ text: 'The newest message' }],
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

      // messages[0].text is the newest message (from descending order + take: 1)
      expect(data.conversations[0].lastMessage).toBe('The newest message');
    });

    it('returns empty string for conversations with no messages', async () => {
      const mockUser = { id: 'user-1', email: 'test@example.com' };
      const mockConversations = [
        {
          id: 'conv-1',
          title: 'Empty Chat',
          pinned: false,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-10'),
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

      // Empty conversations are filtered out by filter((conv) => conv.messages.length > 0)
      expect(data.conversations).toHaveLength(0);
    });
  });

  describe('Filtering conversations with messages.length > 0', () => {
    it('excludes conversations with empty messages array', async () => {
      const mockUser = { id: 'user-1', email: 'test@example.com' };
      const mockConversations = [
        {
          id: 'conv-1',
          title: 'Has Message',
          pinned: false,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-10'),
          summary: null,
          summaryUpdatedAt: null,
          messages: [{ text: 'A message' }],
        },
        {
          id: 'conv-2',
          title: 'Empty',
          pinned: false,
          createdAt: new Date('2024-01-02'),
          updatedAt: new Date('2024-01-09'),
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

      // Only conv-1 should be in response
      expect(data.conversations).toHaveLength(1);
      expect(data.conversations[0].id).toBe('conv-1');
    });

    it('includes all conversations with at least one message', async () => {
      const mockUser = { id: 'user-1', email: 'test@example.com' };
      const mockConversations = [
        {
          id: 'conv-1',
          title: 'Chat 1',
          pinned: false,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-10'),
          summary: null,
          summaryUpdatedAt: null,
          messages: [{ text: 'Message 1' }],
        },
        {
          id: 'conv-2',
          title: 'Chat 2',
          pinned: false,
          createdAt: new Date('2024-01-02'),
          updatedAt: new Date('2024-01-11'),
          summary: null,
          summaryUpdatedAt: null,
          messages: [{ text: 'Message 2' }],
        },
        {
          id: 'conv-3',
          title: 'Chat 3',
          pinned: false,
          createdAt: new Date('2024-01-03'),
          updatedAt: new Date('2024-01-12'),
          summary: null,
          summaryUpdatedAt: null,
          messages: [{ text: 'Message 3' }],
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

      expect(data.conversations).toHaveLength(3);
      expect(data.conversations[0].lastMessage).toBe('Message 1');
      expect(data.conversations[1].lastMessage).toBe('Message 2');
      expect(data.conversations[2].lastMessage).toBe('Message 3');
    });
  });

  describe('API response shape is preserved', () => {
    it('includes all required response fields', async () => {
      const mockUser = { id: 'user-1', email: 'test@example.com' };
      const mockConversations = [
        {
          id: 'conv-1',
          title: 'Test Conversation',
          pinned: true,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-10'),
          summary: 'A summary of the conversation',
          summaryUpdatedAt: new Date('2024-01-09'),
          messages: [{ text: 'Latest message' }],
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

      const conv = data.conversations[0];
      expect(conv).toHaveProperty('id', 'conv-1');
      expect(conv).toHaveProperty('title', 'Test Conversation');
      expect(conv).toHaveProperty('pinned', true);
      expect(conv).toHaveProperty('createdAt');
      expect(conv).toHaveProperty('updatedAt');
      expect(conv).toHaveProperty('summary', 'A summary of the conversation');
      expect(conv).toHaveProperty('summaryUpdatedAt');
      expect(conv).toHaveProperty('recentMessageWindow', 40);
      expect(conv).toHaveProperty('lastMessage', 'Latest message');
    });
  });

  describe('Normal Chat and Live Tutor sources', () => {
    it('handles chat source correctly', async () => {
      const mockUser = { id: 'user-1', email: 'test@example.com' };
      const mockConversations = [
        {
          id: 'conv-1',
          title: 'Normal Chat',
          pinned: false,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-10'),
          summary: null,
          summaryUpdatedAt: null,
          messages: [{ text: 'Chat message' }],
        },
      ];

      (getUserFromRequest as any).mockResolvedValue(mockUser);
      (getUserConversations as any).mockResolvedValue(mockConversations);
      (enforceChatEndpointRateLimit as any).mockResolvedValue({ ok: true });

      const request = new NextRequest(
        'http://localhost:3000/api/conversations?source=chat',
        { method: 'GET' }
      );

      const response = await GET(request);
      const data = await response.json();

      expect(data.conversations).toHaveLength(1);
      expect(data.conversations[0].lastMessage).toBe('Chat message');
    });

    it('handles live_tutor source correctly', async () => {
      const mockUser = { id: 'user-1', email: 'test@example.com' };
      const mockConversations = [
        {
          id: 'session-1',
          title: 'Live Tutor Session',
          pinned: false,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-10'),
          summary: null,
          summaryUpdatedAt: null,
          messages: [{ text: 'Live tutor message' }],
        },
      ];

      (getUserFromRequest as any).mockResolvedValue(mockUser);
      (getUserConversations as any).mockResolvedValue(mockConversations);
      (enforceChatEndpointRateLimit as any).mockResolvedValue({ ok: true });

      const request = new NextRequest(
        'http://localhost:3000/api/conversations?source=live_tutor',
        { method: 'GET' }
      );

      const response = await GET(request);
      const data = await response.json();

      expect(data.conversations).toHaveLength(1);
      expect(data.conversations[0].lastMessage).toBe('Live tutor message');
    });
  });
});
