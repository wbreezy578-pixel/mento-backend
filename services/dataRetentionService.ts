import { prisma } from '../lib/prisma';

export const CONVERSATION_RETENTION_DAYS = 365;

export function getConversationRetentionCutoff(now = new Date()): Date {
  return new Date(now.getTime() - CONVERSATION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

export async function purgeExpiredConversations(now = new Date()): Promise<{ deletedConversations: number; cutoff: Date }> {
  const cutoff = getConversationRetentionCutoff(now);
  const deletedConversations = await prisma.$transaction(async (tx) => {
    await tx.chatOperation.deleteMany({
      where: { expiresAt: { lt: now }, status: { not: 'IN_PROGRESS' } },
    });
    await tx.liveTutorSession.updateMany({
      where: { conversation: { updatedAt: { lt: cutoff } } },
      data: { conversationId: null },
    });
    const result = await tx.conversation.deleteMany({ where: { updatedAt: { lt: cutoff } } });
    return result.count;
  });
  return { deletedConversations, cutoff };
}
