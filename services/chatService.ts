import { prisma } from '../lib/prisma';

export async function saveChatToDatabase(userId: string, prompt: string, response: string, requestId: string) {
  if (!userId) throw new Error('userId is required');
  if (typeof prompt !== 'string' || typeof response !== 'string') throw new Error('prompt and response must be strings');
  if (!requestId.trim()) throw new Error('requestId is required');

  return prisma.$transaction(async (tx) => {
    const conversation = await tx.conversation.create({
      data: { userId, source: 'chat', title: 'Image Analysis' },
      select: { id: true },
    });
    const userMessage = await tx.conversationMessage.create({
      data: {
        conversationId: conversation.id,
        userId,
        role: 'user',
        status: 'completed',
        content: prompt,
        text: prompt,
        requestId,
      },
      select: { id: true },
    });
    const assistantMessage = await tx.conversationMessage.create({
      data: {
        conversationId: conversation.id,
        userId,
        role: 'assistant',
        status: 'completed',
        content: response,
        text: response,
        requestId,
      },
      select: { id: true },
    });
    return {
      conversationId: conversation.id,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
    };
  });
}

export default saveChatToDatabase;
