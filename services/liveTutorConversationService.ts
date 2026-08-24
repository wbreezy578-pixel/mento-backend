import { prisma } from '../lib/prisma';
import { addMessageToConversation, createConversation, getConversation, setConversationTitleIfMissing } from '../lib/conversationDb';

export const LIVE_TUTOR_CONVERSATION_SOURCE = 'live_tutor';

type FinalizedTurn = {
  conversationId: string;
  userId: string;
  sessionId: string;
  turnNumber: number;
  userText?: string;
  assistantText?: string;
};

const persistedTurns = new Set<string>();

export async function createLiveTutorConversation(userId: string) {
  return createConversation(userId, null, LIVE_TUTOR_CONVERSATION_SOURCE);
}

export async function attachLiveTutorConversation(streamId: string, userId: string, conversationId: string) {
  return prisma.liveTutorSession.updateMany({ where: { streamId, userId }, data: { conversationId } });
}

export function persistLiveTutorTurn(turn: FinalizedTurn): void {
  const key = `${turn.sessionId}:${turn.turnNumber}`;
  if (persistedTurns.has(key)) return;
  persistedTurns.add(key);

  void (async () => {
    try {
      const conversation = await prisma.conversation.findFirst({
        where: { id: turn.conversationId, userId: turn.userId, source: LIVE_TUTOR_CONVERSATION_SOURCE },
        select: { id: true },
      });
      if (!conversation) return;

      const requestId = `live-tutor:${turn.sessionId}:${turn.turnNumber}`;
      const userText = turn.userText?.trim();
      const assistantText = turn.assistantText?.trim();
      if (userText) await addMessageToConversation(turn.conversationId, 'user', userText, turn.userId, { requestId });
      if (assistantText) await addMessageToConversation(turn.conversationId, 'assistant', assistantText, turn.userId, { requestId });
      if (userText) await setConversationTitleIfMissing(turn.conversationId, userText);
    } catch (error) {
      persistedTurns.delete(key);
      console.warn('[LiveTutorConversation] persistence failed:', error instanceof Error ? error.message : String(error));
    }
  })();
}

export async function listLiveTutorConversations(userId: string) {
  return prisma.conversation.findMany({
    where: { userId, source: LIVE_TUTOR_CONVERSATION_SOURCE },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, title: true, createdAt: true, updatedAt: true, messages: { take: 1, orderBy: { createdAt: 'desc' }, select: { text: true, content: true } } },
  });
}

export async function getOwnedLiveTutorConversation(conversationId: string, userId: string) {
  return prisma.conversation.findFirst({
    where: { id: conversationId, userId, source: LIVE_TUTOR_CONVERSATION_SOURCE },
    select: { id: true, userId: true, title: true, createdAt: true, updatedAt: true, messages: { orderBy: { createdAt: 'asc' }, select: { id: true, role: true, text: true, content: true, createdAt: true } } },
  });
}

export async function getLiveTutorConversationContext(conversationId: string | null | undefined, userId: string): Promise<string | null> {
  if (!conversationId) return null;

  const conversation = await getOwnedLiveTutorConversation(conversationId, userId);
  if (!conversation || conversation.messages.length === 0) return null;

  const recentMessages = conversation.messages.slice(-20).map((message) => {
    const text = (message.text ?? message.content ?? '').trim();
    return text ? `${message.role === 'user' ? 'Learner' : 'Tutor'}: ${text}` : null;
  }).filter((message): message is string => Boolean(message));

  return recentMessages.length > 0
    ? `Recent conversation context. Use it for continuity, but prioritize the learner's newest spoken turn:\n${recentMessages.join('\n')}`
    : null;
}