import { prisma } from '../lib/prisma';

export async function saveChatToDatabase(userId: string, prompt: string, response: string) {
  if (!userId) throw new Error('userId is required');
  if (typeof prompt !== 'string' || typeof response !== 'string') throw new Error('prompt and response must be strings');

  // Find the user's most recent conversation or create a new one
  let conversation = await prisma.conversation.findFirst({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
  });

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: { userId },
    });
  }

  const messages = await prisma.conversationMessage.createManyAndReturn({
    data: [
      { conversationId: conversation.id, userId, role: 'user', text: prompt },
      { conversationId: conversation.id, userId, role: 'assistant', text: response },
    ],
    select: { id: true, role: true },
  });

  const userMsg = messages.find((message) => message.role === 'user');
  const assistantMsg = messages.find((message) => message.role === 'assistant');
  if (!userMsg || !assistantMsg) throw new Error('Failed to persist chat messages');

  return {
    conversationId: conversation.id,
    userMessageId: userMsg.id,
    assistantMessageId: assistantMsg.id,
  };
}

export default saveChatToDatabase;
