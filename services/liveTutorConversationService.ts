import { prisma } from '../lib/prisma';
import { createConversation } from '../lib/conversationDb';

export const LIVE_TUTOR_CONVERSATION_SOURCE = 'live_tutor';

type FinalizedTurn = {
  conversationId: string;
  userId: string;
  sessionId: string;
  turnNumber: number;
  userText?: string;
  assistantText?: string;
};

export async function createLiveTutorConversation(userId: string) {
  return createConversation(userId, null, LIVE_TUTOR_CONVERSATION_SOURCE);
}

export async function attachLiveTutorConversation(streamId: string, userId: string, conversationId: string) {
  return prisma.liveTutorSession.updateMany({ where: { streamId, userId }, data: { conversationId } });
}

export async function persistLiveTutorTurn(turn: FinalizedTurn): Promise<void> {
  const requestId = `live-tutor:${turn.sessionId}:${turn.turnNumber}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await prisma.$transaction(async (tx) => {
      // Serialize turn writes across replicas, and commit both roles together.
      await tx.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${turn.conversationId} AND "userId" = ${turn.userId} FOR UPDATE`;
      const conversation = await tx.conversation.findFirst({
        where: { id: turn.conversationId, userId: turn.userId, source: LIVE_TUTOR_CONVERSATION_SOURCE },
        select: { id: true },
      });
      if (!conversation) throw new Error('Live Tutor conversation unavailable.');
      const userText = turn.userText?.trim();
      const assistantText = turn.assistantText?.trim();
      for (const [role, text] of [['user', userText], ['assistant', assistantText]] as const) {
        if (!text) continue;
        await tx.conversationMessage.upsert({
          where: { conversationId_requestId_role: { conversationId: turn.conversationId, requestId, role } },
          update: {},
          create: { conversationId: turn.conversationId, userId: turn.userId, requestId, role, status: 'completed', text, content: text },
        });
      }
      await tx.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });
      if (userText) await tx.conversation.updateMany({ where: { id: conversation.id, title: null }, data: { title: userText.slice(0, 100) } });
      });
      return;
    } catch (error) {
      if (attempt === 2) throw new Error('Live Tutor turn could not be saved.');
    }
  }
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

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId, source: LIVE_TUTOR_CONVERSATION_SOURCE },
    select: { messages: {
      where: { status: 'completed', role: { in: ['user', 'assistant'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 20,
      select: { role: true, text: true, content: true },
    } },
  });
  if (!conversation || conversation.messages.length === 0) return null;

  return buildLiveTutorHistoricalContext([...conversation.messages].reverse());
}

// UTF-8 bytes conservatively bound text tokens without assuming English or
// character/token equivalence. Includes JSON provenance and escaping overhead.
export const LIVE_TUTOR_HISTORY_MAX_BYTES = 12_000;
export function buildLiveTutorHistoricalContext(messages: Array<{ role: string; text?: string | null; content?: string }>): string | null {
  const history: Array<{ speaker: string; text: string }> = [];
  for (const message of [...messages].reverse()) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = (message.text ?? message.content ?? '').trim();
    if (!text) continue;
    const entry = { speaker: message.role, text };
    if (Buffer.byteLength(JSON.stringify([entry, ...history]), 'utf8') > LIVE_TUTOR_HISTORY_MAX_BYTES) break;
    history.unshift(entry);
  }
  return history.length ? JSON.stringify(history) : null;
}
