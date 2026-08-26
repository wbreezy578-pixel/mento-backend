import { prisma } from './prisma';

const messageDedupCache = new Map<string, { expiresAt: number; messageId: string }>();
const AI_HISTORY_MESSAGE_LIMIT = 40;
export const RECENT_MESSAGE_WINDOW = AI_HISTORY_MESSAGE_LIMIT;

/**
 * Server-side conversation management.
 * All history is stored and validated on the server.
 * This prevents session injection and history tampering.
 */

export async function createConversation(userId: string, title: string | null, source: string) {
  return await prisma.conversation.create({
    data: {
      userId,
      title: title?.trim() ? title.trim() : null,
      source,
      messages: {
        create: [],
      },
    },
  });
}

export async function createConversationWithInitialMessage(
  userId: string,
  initialMessage: string,
  options?: { requestId?: string; source?: string },
) {
  const text = initialMessage.trim();
  if (!text) throw new Error('Initial message is required.');

  return prisma.$transaction(async (tx) => {
    const conversation = await tx.conversation.create({
      data: { userId, source: options?.source ?? 'chat' },
    });
    await tx.conversationMessage.create({
      data: {
        conversationId: conversation.id,
        userId,
        role: 'user',
        status: 'completed',
        content: text,
        text,
      },
    });
    return conversation;
  });
}

export async function getConversation(conversationId: string) {
  return await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      userId: true,
      title: true,
      pinned: true,
      createdAt: true,
      updatedAt: true,
      summary: true,
      summaryUpdatedAt: true,
      messages: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          conversationId: true,
          role: true,
          text: true,
          content: true,
          createdAt: true,
        },
      },
    },
  });
}

/**
 * Validate ownership: ensure the user owns this conversation.
 * Prevents session injection attacks.
 */
export async function validateConversationOwnership(conversationId: string, userId: string): Promise<boolean> {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { userId: true },
  });
  return conv?.userId === userId;
}

/**
 * Add a message to a conversation.
 * Server maintains authoritative history.
 */
export async function addMessageToConversation(
  conversationId: string,
  role: 'user' | 'assistant',
  text: string,
  userId?: string,
  options?: { requestId?: string; status?: 'streaming' | 'completed' | 'failed' }
) {
  const dedupKey = options?.requestId ? `${options.requestId}:${role}` : undefined;
  if (dedupKey) {
    const cached = messageDedupCache.get(dedupKey);
    if (cached && cached.expiresAt > Date.now()) {
      return await prisma.conversationMessage.findUnique({
        where: { id: cached.messageId },
        select: {
          id: true,
          conversationId: true,
          role: true,
          text: true,
          content: true,
          createdAt: true,
        },
      });
    }
  }

  const recentDuplicate = await prisma.conversationMessage.findFirst({
    where: {
      conversationId,
      role,
      userId: userId ?? '',
      OR: [{ content: text }, { text }],
      createdAt: {
        gte: new Date(Date.now() - 5_000),
      },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      conversationId: true,
      role: true,
      text: true,
      content: true,
      createdAt: true,
    },
  });

  if (recentDuplicate) {
    return recentDuplicate;
  }

  const message = await prisma.conversationMessage.create({
    data: {
      conversationId,
      userId: userId ?? '',
      role,
        status: options?.status ?? 'completed',
      content: text,
      text,
    },
  });

  if (dedupKey) {
    messageDedupCache.set(dedupKey, { expiresAt: Date.now() + 60_000, messageId: message.id });
  }

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  });

  return message;
}

/**
 * Get conversation history formatted for Gemini.
 * Always retrieve from server; never trust frontend history.
 */
export async function getConversationHistoryForAI(conversationId: string) {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      messages: {
        orderBy: { createdAt: 'desc' },
        take: AI_HISTORY_MESSAGE_LIMIT,
        select: {
          role: true,
          content: true,
          text: true,
        },
      },
    },
  });
  if (!conv) return [];
  return conv.messages.reverse().map((msg) => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content ?? msg.text ?? '' }],
  }));
}

export async function updateConversationSummary(conversationId: string) {
  const messages = await prisma.conversationMessage.findMany({
    where: { conversationId, role: { in: ['user', 'assistant'] }, status: { not: 'failed' } },
    orderBy: { createdAt: 'desc' },
    take: 6,
    select: { role: true, content: true, text: true },
  });
  const prompts = messages.filter((message) => message.role === 'user')
    .map((message) => (message.content ?? message.text ?? '').trim())
    .filter(Boolean)
    .reverse();
  if (!prompts.length) return null;
  const summary = prompts.map((prompt) => prompt.replace(/\s+/g, ' ').slice(0, 140)).join(' | ').slice(0, 500);
  return prisma.conversation.update({ where: { id: conversationId }, data: { summary, summaryUpdatedAt: new Date() } });
}

function titleize(value: string) {
  return value
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function generateConversationTitleFromText(userText: string) {
  const cleaned = userText
    .trim()
    .replace(/[?!.]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();

  const patterns: Array<{ regex: RegExp; suffix: string }> = [
    { regex: /^(?:help me study|please help me study|help me learn|please help me learn)\s+(.+)/i, suffix: 'Revision' },
    { regex: /^(?:help me understand|help me with|help me)\s+(.+)/i, suffix: 'Guide' },
    { regex: /^(?:how do|how does|how can i|how can|what is|what are|why does|why is|why are)\s+(.+?)$/i, suffix: 'Help' },
    { regex: /^(?:explain|tell me about|define)\s+(.+)$/i, suffix: 'Guide' }
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern.regex);
    if (match && match[1]) {
      const phrase = match[1]
        .replace(/\b(please|the|a|an|i|me|my|for|to|with|about|of|in|on|at|is|are|do|does|can|how|what|why)\b/gi, '')
        .replace(/\b(work|study|learn|understand|help)\b/gi, '')
        .trim();
      const short = titleize(phrase);
      if (!short) continue;
      return `${short} ${pattern.suffix}`.trim().slice(0, 40).split(' ').slice(0, 5).join(' ');
    }
  }

  const cleanedSubject = cleaned
    .replace(/\b(please|help|me|can|you|i|want|to|for|the|a|an|in|on|about|with|and|or|of|is|are|do|does|how|what|why|study|learn|understand|explain|tell|show)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleanedSubject.length > 0) {
    return titleize(cleanedSubject).slice(0, 40).split(' ').slice(0, 5).join(' ');
  }

  return 'Quick Chat';
}

export async function setConversationTitleIfMissing(conversationId: string, userText: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { title: true },
  });

  if (!conversation) return null;
  if (conversation.title?.trim()) return conversation;

  const title = generateConversationTitleFromText(userText);
  return await updateConversationTitle(conversationId, title);
}

/**
 * Delete a conversation (user cleanup).
 */
export async function deleteConversation(conversationId: string) {
  return await prisma.conversation.delete({
    where: { id: conversationId },
  });
}

/**
 * Update a conversation title.
 */
export async function updateConversationTitle(conversationId: string, title: string) {
  return await prisma.conversation.update({
    where: { id: conversationId },
    data: { title: title.trim() ? title.trim() : null },
  });
}

/**
 * Get all conversations for a user, sorted by pinned (desc) then by updatedAt (desc).
 * Pinned conversations appear at the top.
 */
export async function getUserConversations(userId: string, source?: string) {
  return await prisma.conversation.findMany({
    where: { userId, ...(source ? { source } : {}) },
    orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
    select: {
      id: true,
      title: true,
      pinned: true,
      createdAt: true,
      updatedAt: true,
      summary: true,
      summaryUpdatedAt: true,
      messages: {
        take: 1,
        orderBy: { createdAt: 'desc' },
        select: { text: true },
      },
    },
  });
}

/**
 * Pin a conversation.
 */
export async function pinConversation(conversationId: string) {
  return await prisma.conversation.update({
    where: { id: conversationId },
    data: { pinned: true },
  });
}

/**
 * Unpin a conversation.
 */
export async function unpinConversation(conversationId: string) {
  return await prisma.conversation.update({
    where: { id: conversationId },
    data: { pinned: false },
  });
}

export default {
  createConversation,
  createConversationWithInitialMessage,
  getConversation,
  validateConversationOwnership,
  addMessageToConversation,
  getConversationHistoryForAI,
  deleteConversation,
  updateConversationTitle,
  getUserConversations,
  updateConversationSummary,
  pinConversation,
  unpinConversation,
};
