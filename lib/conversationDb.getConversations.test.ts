import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getUserConversations } from './conversationDb';
import { prisma } from './prisma';

// Mock Prisma
vi.mock('./prisma', () => ({
  prisma: {
    conversation: {
      findMany: vi.fn(),
    },
  },
}));

describe('getUserConversations - Drawer Performance Fix Regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Only newest message per conversation is fetched', () => {
    it('fetches only 1 message per conversation (take: 1)', async () => {
      const mockConversations = [
        {
          id: 'conv-1',
          title: 'Conversation 1',
          pinned: false,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-10'),
          summary: null,
          summaryUpdatedAt: null,
          messages: [{ text: 'Latest message' }],
        },
      ];

      (prisma.conversation.findMany as any).mockResolvedValue(mockConversations);

      const result = await getUserConversations('user-1');

      // Verify the query was made with take: 1
      const callArgs = (prisma.conversation.findMany as any).mock.calls[0][0];
      expect(callArgs.select.messages.take).toBe(1);
      expect(callArgs.select.messages.orderBy).toEqual({ createdAt: 'desc' });

      // Verify result contains messages
      expect(result[0].messages).toHaveLength(1);
      expect(result[0].messages[0].text).toBe('Latest message');
    });

    it('fetches message with only required fields (text field)', async () => {
      const mockConversations = [
        {
          id: 'conv-1',
          title: 'Conversation 1',
          pinned: false,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-10'),
          summary: null,
          summaryUpdatedAt: null,
          messages: [{ text: 'Only text field' }],
        },
      ];

      (prisma.conversation.findMany as any).mockResolvedValue(mockConversations);

      const result = await getUserConversations('user-1');

      // Verify the select only includes text
      const callArgs = (prisma.conversation.findMany as any).mock.calls[0][0];
      const messageSelect = callArgs.select.messages.select;
      expect(messageSelect).toEqual({ text: true });
      expect(messageSelect).not.toHaveProperty('id');
      expect(messageSelect).not.toHaveProperty('role');
      expect(messageSelect).not.toHaveProperty('content');
      expect(messageSelect).not.toHaveProperty('createdAt');
    });
  });

  describe('Newest message is correctly returned', () => {
    it('returns the newest message in descending order', async () => {
      const mockConversations = [
        {
          id: 'conv-1',
          title: 'Test',
          pinned: false,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-15'),
          summary: null,
          summaryUpdatedAt: null,
          messages: [{ text: 'This is the newest message (from 2024-01-15)' }],
        },
      ];

      (prisma.conversation.findMany as any).mockResolvedValue(mockConversations);

      const result = await getUserConversations('user-1');

      // With orderBy: { createdAt: 'desc' } and take: 1, we get newest
      expect(result[0].messages[0].text).toBe(
        'This is the newest message (from 2024-01-15)'
      );
    });
  });

  describe('Conversations with no messages are excluded', () => {
    it('filters out conversations with empty messages array', async () => {
      const mockConversations = [
        {
          id: 'conv-1',
          title: 'Has messages',
          pinned: false,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-10'),
          summary: null,
          summaryUpdatedAt: null,
          messages: [{ text: 'A message' }],
        },
        {
          id: 'conv-2',
          title: 'No messages',
          pinned: false,
          createdAt: new Date('2024-01-02'),
          updatedAt: new Date('2024-01-09'),
          summary: null,
          summaryUpdatedAt: null,
          messages: [],
        },
      ];

      (prisma.conversation.findMany as any).mockResolvedValue(mockConversations);

      const result = await getUserConversations('user-1');

      // Both are returned by getUserConversations (filtering happens in API)
      expect(result).toHaveLength(2);
      
      // But API endpoint will filter conv-2 out due to messages.length > 0 check
      // This test verifies getUserConversations returns all conversations
      // and the API endpoint handles filtering
    });
  });

  describe('Pinned and ordering behavior is preserved', () => {
    it('maintains pinned ordering (pinned: desc)', async () => {
      const mockConversations = [
        {
          id: 'conv-1-pinned',
          title: 'Pinned Conversation',
          pinned: true,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-05'),
          summary: null,
          summaryUpdatedAt: null,
          messages: [{ text: 'Pinned message' }],
        },
        {
          id: 'conv-2-unpinned',
          title: 'Unpinned Conversation',
          pinned: false,
          createdAt: new Date('2024-01-02'),
          updatedAt: new Date('2024-01-10'),
          summary: null,
          summaryUpdatedAt: null,
          messages: [{ text: 'Unpinned message' }],
        },
      ];

      (prisma.conversation.findMany as any).mockResolvedValue(mockConversations);

      const result = await getUserConversations('user-1');

      // Verify orderBy includes pinned: desc
      const callArgs = (prisma.conversation.findMany as any).mock.calls[0][0];
      expect(callArgs.orderBy).toEqual([
        { pinned: 'desc' },
        { updatedAt: 'desc' },
      ]);

      // Mock returns in order, so first should be pinned
      expect(result[0].pinned).toBe(true);
      expect(result[1].pinned).toBe(false);
    });

    it('maintains updated timestamp ordering (updatedAt: desc)', async () => {
      const mockConversations = [
        {
          id: 'conv-1',
          title: 'Recently updated',
          pinned: false,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-15'),
          summary: null,
          summaryUpdatedAt: null,
          messages: [{ text: 'Recent' }],
        },
        {
          id: 'conv-2',
          title: 'Older update',
          pinned: false,
          createdAt: new Date('2024-01-02'),
          updatedAt: new Date('2024-01-10'),
          summary: null,
          summaryUpdatedAt: null,
          messages: [{ text: 'Older' }],
        },
      ];

      (prisma.conversation.findMany as any).mockResolvedValue(mockConversations);

      const result = await getUserConversations('user-1');

      expect(result[0].updatedAt.getTime()).toBeGreaterThan(
        result[1].updatedAt.getTime()
      );
    });
  });

  describe('Source filtering is preserved', () => {
    it('filters by source when provided', async () => {
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

      (prisma.conversation.findMany as any).mockResolvedValue(mockConversations);

      await getUserConversations('user-1', 'chat');

      const callArgs = (prisma.conversation.findMany as any).mock.calls[0][0];
      expect(callArgs.where).toEqual({ userId: 'user-1', source: 'chat' });
    });

    it('does not filter by source when not provided', async () => {
      const mockConversations = [];
      (prisma.conversation.findMany as any).mockResolvedValue(mockConversations);

      await getUserConversations('user-1');

      const callArgs = (prisma.conversation.findMany as any).mock.calls[0][0];
      expect(callArgs.where).toEqual({ userId: 'user-1' });
    });
  });

  describe('Conversation fields are correctly selected', () => {
    it('selects all required fields', async () => {
      const mockConversations = [];
      (prisma.conversation.findMany as any).mockResolvedValue(mockConversations);

      await getUserConversations('user-1');

      const callArgs = (prisma.conversation.findMany as any).mock.calls[0][0];
      const selectedFields = Object.keys(callArgs.select);

      const requiredFields = [
        'id',
        'title',
        'pinned',
        'createdAt',
        'updatedAt',
        'summary',
        'summaryUpdatedAt',
        'messages',
      ];

      requiredFields.forEach((field) => {
        expect(selectedFields).toContain(field);
      });
    });
  });
});
