import { NextResponse } from 'next/server';
import { getUserFromRequest } from '../../../lib/auth';
import { prisma } from '../../../../lib/prisma';
import { buildCorsHeaders } from '../../../../lib/securityHeaders';
import logger from '../../../../lib/logger';

const CORS_METHODS = 'GET, OPTIONS';

export async function OPTIONS(req: Request) {
  logger.info('Chat history preflight', {
    origin: req.headers.get('origin') ?? null,
  });
  return new NextResponse(null, {
    status: 204,
    headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS },
  });
}

/**
 * GET /api/chat/:id
 * Returns full message history for a conversation (ordered by createdAt asc)
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolvedParams = await params;
    logger.info('Chat history request', { conversationId: resolvedParams?.id ?? null });

    const user = await getUserFromRequest(req as Request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });

    const { id } = resolvedParams;
    const url = new URL(req.url);
    const limitParam = url.searchParams.get('limit');
    const beforeId = url.searchParams.get('beforeId');
    const limit = Math.min(Math.max(Number(limitParam ?? '30'), 1), 100);
    const take = limit + 1;

    const messagesQuery: {
      select: {
        id: boolean;
        conversationId: boolean;
        role: boolean;
        text: boolean;
        content: boolean;
        createdAt: boolean;
      };
      orderBy: { createdAt: 'desc' };
      take: number;
      cursor?: { id: string };
      skip?: number;
    } = {
      select: {
        id: true,
        conversationId: true,
        role: true,
        text: true,
        content: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take,
    };

    if (beforeId) {
      messagesQuery.cursor = { id: beforeId };
      messagesQuery.skip = 1;
    }

    const conv = await prisma.conversation.findUnique({
      where: { id },
      include: { messages: messagesQuery },
    });

    if (!conv || conv.userId !== user.id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const messagesDesc = conv.messages;
    const hasMore = messagesDesc.length > limit;
    const limitedMessages = hasMore ? messagesDesc.slice(0, limit) : messagesDesc;
    const messages = limitedMessages.reverse();

    return NextResponse.json({
      conversation: {
        id: conv.id,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        summary: conv.summary,
        summaryUpdatedAt: conv.summaryUpdatedAt,
        messages,
        hasMore,
        recentMessageWindow: 40,
      }
    }, { headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    logger.error('Chat history request failed', { error: err });
    return NextResponse.json({ error: message }, { status: 500, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
  }
}
