import { NextResponse } from 'next/server';
import { getUserFromRequest } from '../../../../lib/auth';
import { prisma } from '../../../../../lib/prisma';
import logger from '../../../../../lib/logger';
import { buildRateLimitHeaders, enforceChatEndpointRateLimit } from '../../../../../lib/chatRateLimits';
import { readJsonBodyWithLimit, RequestBodyError } from '../../../../../lib/requestBody';

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const limit = await enforceChatEndpointRateLimit(user.id, 'feedback');
    if (!limit.ok) {
      return NextResponse.json(
        { error: 'Too much feedback submitted. Please try again later.', code: 'rate_limit_exceeded', retryAfterSec: limit.retryAfterSec },
        { status: 429, headers: buildRateLimitHeaders(limit.retryAfterSec) },
      );
    }

    const body = await readJsonBodyWithLimit<{ messageId?: unknown; feedback?: unknown }>(req, 4 * 1024);
    const { messageId, feedback } = body;

    if (!messageId || typeof messageId !== 'string') {
      return NextResponse.json({ error: 'Invalid messageId' }, { status: 400 });
    }

    if (feedback !== 'up' && feedback !== 'down') {
      return NextResponse.json({ error: 'Invalid feedback value' }, { status: 400 });
    }

    const message = await prisma.conversationMessage.findUnique({
      where: { id: messageId },
      include: { conversation: { select: { userId: true, source: true } } }
    });

    if (!message) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    if (message.conversation.userId !== user.id || message.conversation.source !== 'chat') {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
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
    if (err instanceof RequestBodyError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status, headers: { 'Cache-Control': 'no-store' } });
    }
    logger.error('Feedback submission failed', { error: err });
    return NextResponse.json({ error: 'Unable to save feedback.', code: 'feedback_save_failed' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
