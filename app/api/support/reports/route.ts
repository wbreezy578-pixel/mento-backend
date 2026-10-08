import { NextResponse } from 'next/server';
import { getUserFromRequest } from '../../../lib/auth';
import { prisma } from '../../../../lib/prisma';
import { ensureSlidingWindow } from '../../../../lib/rateLimiter';
import { buildCorsHeaders } from '../../../../lib/securityHeaders';
import { validateSupportReportPayload } from '../../../../lib/supportReport';
import logger from '../../../../lib/logger';

const CORS_METHODS = 'POST, OPTIONS';

function responseHeaders(origin: string | null) {
  return { ...buildCorsHeaders(origin), 'Access-Control-Allow-Methods': CORS_METHODS };
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: responseHeaders(req.headers.get('origin')) });
}

export async function POST(req: Request) {
  const origin = req.headers.get('origin');
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: responseHeaders(origin) });

    const limit = await ensureSlidingWindow(`support-report:${user.id}`, 5, 60 * 60, 'rl:support');
    if (!limit.ok) {
      return NextResponse.json(
        { error: 'Too many reports. Please wait before submitting another.', retryAfterSec: limit.retryAfterSec },
        { status: 429, headers: responseHeaders(origin) },
      );
    }

    const report = validateSupportReportPayload(await req.json().catch(() => null));
    if (report.conversationId) {
      const ownedConversation = await prisma.conversation.findFirst({
        where: { id: report.conversationId, userId: user.id },
        select: { id: true },
      });
      if (!ownedConversation) {
        return NextResponse.json({ error: 'Conversation not found.' }, { status: 404, headers: responseHeaders(origin) });
      }
    }

    if (report.messageId) {
      const ownedMessage = await prisma.conversationMessage.findFirst({
        where: { id: report.messageId, conversation: { userId: user.id } },
        select: { id: true },
      });
      if (!ownedMessage) {
        return NextResponse.json({ error: 'Message not found.' }, { status: 404, headers: responseHeaders(origin) });
      }
    }

    const created = await prisma.supportReport.create({
      data: {
        userId: user.id,
        category: report.category,
        description: report.description,
        conversationId: report.conversationId,
        messageId: report.messageId,
        appVersion: report.appVersion,
      },
      select: { id: true, status: true, createdAt: true },
    });

    return NextResponse.json({ success: true, report: created }, { status: 201, headers: responseHeaders(origin) });
  } catch (error) {
    const validationMessage = error instanceof Error ? error.message : 'Unable to submit report.';
    if (/report payload|report category|description must/i.test(validationMessage)) {
      return NextResponse.json({ error: validationMessage }, { status: 400, headers: responseHeaders(origin) });
    }
    logger.error('Support report submission failed', { error: error instanceof Error ? error.name : 'unknown' });
    return NextResponse.json({ error: 'Unable to submit report right now.' }, { status: 500, headers: responseHeaders(origin) });
  }
}

export const runtime = 'nodejs';
