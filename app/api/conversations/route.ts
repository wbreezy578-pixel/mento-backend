import { NextResponse } from 'next/server';
import { getUserFromRequest } from '../../lib/auth';
import { getUserConversations, validateConversationOwnership } from '../../../lib/conversationDb';
import logger, { warn } from '../../../lib/logger';
import { buildCorsHeaders } from '../../../lib/securityHeaders';

const CORS_METHODS = 'GET, POST, OPTIONS';

export async function OPTIONS(req: Request) {
  logger.info('Conversations preflight', {
    origin: req.headers.get('origin') ?? null,
  });
  return new NextResponse(null, {
    status: 204,
    headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS },
  });
}

/**
 * GET /api/conversations
 *
 * List all conversations for the authenticated user.
 * Sorted by pinned (desc) then by updatedAt (desc).
 *
 * Response:
 *   { conversations: Array<{ id, pinned, createdAt, updatedAt, lastMessage }> }
 */

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const source = new URL(req.url).searchParams.get('source')?.trim() || undefined;
    const conversations = await getUserConversations(user.id, source);

    return NextResponse.json({
      conversations: conversations.filter((conv) => conv.messages.length > 0).map((conv) => ({
        id: conv.id,
        title: conv.title,
        pinned: conv.pinned,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        summary: conv.summary,
        summaryUpdatedAt: conv.summaryUpdatedAt,
        recentMessageWindow: 40,
        lastMessage: conv.messages[0].text,
      })),
    }, { headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    warn('Error fetching conversations', { error: message });
    return NextResponse.json({ error: message }, { status: 500, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
  }
}
