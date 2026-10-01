import { NextResponse } from 'next/server';
import { getUserFromRequest } from '../../../../lib/auth';
import { updateConversationTitle, validateConversationOwnership } from '../../../../../lib/conversationDb';
import { warn } from '../../../../../lib/logger';
import { buildRateLimitHeaders, enforceChatEndpointRateLimit } from '../../../../../lib/chatRateLimits';
import { readJsonBodyWithLimit, RequestBodyError } from '../../../../../lib/requestBody';
import { buildCorsHeaders } from '../../../../../lib/securityHeaders';

const CORS_METHODS = 'POST, OPTIONS';

export async function OPTIONS(req: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS },
  });
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }
    const rateLimit = await enforceChatEndpointRateLimit(user.id, 'rename');
    if (!rateLimit.ok) {
      return NextResponse.json(
        { error: 'Too many rename requests. Please try again later.', code: 'rate_limit_exceeded', retryAfterSec: rateLimit.retryAfterSec },
        { status: 429, headers: { ...buildCorsHeaders(req.headers.get('origin')), ...buildRateLimitHeaders(rateLimit.retryAfterSec), 'Access-Control-Allow-Methods': CORS_METHODS } },
      );
    }

    const { id: conversationId } = await context.params;
    const body = await readJsonBodyWithLimit<{ title?: unknown }>(req, 4 * 1024);
    const title = typeof body?.title === 'string' ? body.title.normalize('NFC').trim() : '';

    const owns = await validateConversationOwnership(conversationId, user.id);
    if (!owns) {
      warn('Unauthorized rename attempt', { userId: user.id, conversationId });
      return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    if (!title || title.length > 120) {
      return NextResponse.json({ error: 'A title between 1 and 120 characters is required.' }, { status: 400, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    await updateConversationTitle(conversationId, title);
    return NextResponse.json({ success: true }, { headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
  } catch (error: unknown) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    warn('Error renaming conversation', { error: message });
    return NextResponse.json({ error: 'Unable to rename the conversation.', code: 'conversation_rename_failed' }, { status: 500, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
  }
}
