import { NextResponse } from 'next/server';
import { getUserFromRequest } from '../../../../lib/auth';
import { prisma } from '../../../../../lib/prisma';
import logger from '../../../../../lib/logger';

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { messageId, feedback } = body;

    if (!messageId || typeof messageId !== 'string') {
      return NextResponse.json({ error: 'Invalid messageId' }, { status: 400 });
    }

    if (feedback !== 'up' && feedback !== 'down') {
      return NextResponse.json({ error: 'Invalid feedback value' }, { status: 400 });
    }

    const message = await prisma.conversationMessage.findUnique({
      where: { id: messageId },
      include: { conversation: { select: { userId: true } } }
    });

    if (!message) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    if (message.conversation.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const updated = await prisma.conversationMessage.update({
      where: { id: messageId },
      data: {
        feedback: feedback === 'up' ? 'up' : 'down'
      }
    });

    await prisma.chatAnalyticsEvent.create({
      data: {
        userId: user.id,
        conversationId: message.conversationId,
        messageId,
        eventType: 'response_feedback',
        metadata: { feedback },
      },
    });

    return NextResponse.json({ success: true, message: updated, feedback: updated.feedback });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    logger.error('Feedback submission failed', { error: err });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
