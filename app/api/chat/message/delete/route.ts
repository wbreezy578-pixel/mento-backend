import { NextResponse } from 'next/server';
import { getUserFromRequest } from '../../../../lib/auth';
import { prisma } from '../../../../../lib/prisma';
import logger from '../../../../../lib/logger';
import { acquireAIGenerationLock, releaseAIGenerationLock } from '../../../../../lib/aiGenerationLock';
import { randomUUID } from 'node:crypto';

/**
 * DELETE /api/chat/message/delete
 * Delete a single message from a conversation (auth required)
 */
export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { messageId } = body;

    if (!messageId || typeof messageId !== 'string') {
      return NextResponse.json({ error: 'Invalid messageId' }, { status: 400 });
    }

    // Fetch the message to verify conversation ownership
    const message = await prisma.conversationMessage.findUnique({
      where: { id: messageId },
      include: { conversation: { select: { userId: true } } }
    });

    if (!message) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    // Verify user owns the conversation
    if (message.conversation.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const lockOwner = `${user.id}:chat-delete:${randomUUID()}`;
    if (!await acquireAIGenerationLock(message.conversationId, lockOwner)) {
      return NextResponse.json(
        { error: 'This conversation is busy. Wait for the current response to finish.', code: 'generation_in_progress' },
        { status: 409 },
      );
    }

    let deletedMessageIds: string[] = [];
    try {
      // Deleting a turn invalidates every later turn because those replies were
      // generated from that context. Remove the branch atomically.
      const orderedMessages = await prisma.conversationMessage.findMany({
        where: { conversationId: message.conversationId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      const targetIndex = orderedMessages.findIndex((item) => item.id === messageId);
      if (targetIndex < 0) {
        return NextResponse.json({ error: 'Message not found' }, { status: 404 });
      }
      if (targetIndex === 0) {
        return NextResponse.json(
          {
            error: 'Deleting the first message would delete the entire conversation. Use Delete Conversation instead.',
            code: 'delete_conversation_required',
          },
          { status: 409 },
        );
      }
      deletedMessageIds = orderedMessages.slice(targetIndex).map((item) => item.id);
      await prisma.$transaction([
        prisma.conversationMessage.deleteMany({ where: { id: { in: deletedMessageIds } } }),
        prisma.conversation.update({
          where: { id: message.conversationId },
          data: { updatedAt: new Date(), summary: null, summaryUpdatedAt: null },
        }),
      ]);
    } finally {
      await releaseAIGenerationLock(message.conversationId, lockOwner).catch(() => undefined);
    }

    return NextResponse.json({ success: true, messageId, deletedMessageIds });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    logger.error('Delete message failed', { error: err });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
