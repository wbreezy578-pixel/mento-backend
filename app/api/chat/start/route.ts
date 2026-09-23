import { NextResponse } from 'next/server';
import { createConversationWithInitialMessage } from '../../../../lib/conversationDb';
import { info, warn } from '../../../../lib/logger';
import { buildCorsHeaders } from '../../../../lib/securityHeaders';
import { authenticateAIRequest, buildAIRequestId, getClientIp, secureAITextInput, AIRequestGatewayError } from '../../../../lib/aiSecurityGateway';
import { buildRateLimitHeaders, enforceChatEndpointRateLimit } from '../../../../lib/chatRateLimits';
import { readJsonBodyWithLimit, RequestBodyError } from '../../../../lib/requestBody';

const CORS_METHODS = 'POST, OPTIONS';

export async function OPTIONS(req: Request) {
  info('Chat start preflight', {
    origin: req.headers.get('origin') ?? null,
  });
  return new NextResponse(null, {
    status: 204,
    headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS },
  });
}

/**
 * POST /api/chat/start
 *
 * Start a new conversation for the authenticated user.
 *
 * Response:
 *   { conversationId: string }
 */

export async function POST(req: Request) {
  try {
    const user = await authenticateAIRequest(req);
    const limit = await enforceChatEndpointRateLimit(user.id, 'start');
    if (!limit.ok) {
      return NextResponse.json(
        { error: 'Too many new conversations. Please try again later.', code: 'rate_limit_exceeded', retryAfterSec: limit.retryAfterSec },
        { status: 429, headers: { ...buildCorsHeaders(req.headers.get('origin')), ...buildRateLimitHeaders(limit.retryAfterSec), 'Access-Control-Allow-Methods': CORS_METHODS } },
      );
    }

    const body = await readJsonBodyWithLimit<{ initialMessage?: unknown; requestId?: unknown }>(req, 16 * 1024);
    const initialMessage = typeof body?.initialMessage === 'string' ? body.initialMessage.trim() : '';
    if (!initialMessage || initialMessage.length > 8_000) {
      return NextResponse.json({ error: 'A valid initial message is required.' }, { status: 400, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }
    const requestId = typeof body?.requestId === 'string' && body.requestId.trim()
      ? body.requestId.trim().slice(0, 200)
      : buildAIRequestId('chat-start');
    const secured = await secureAITextInput({
      userId: user.id,
      requestId,
      ip: getClientIp(req),
      input: initialMessage,
    });
    const conversation = await createConversationWithInitialMessage(user.id, secured.sanitizedInput, { requestId, source: 'chat' });
    info('New conversation created with initial message', { category: 'conversation_created' });

    return NextResponse.json({ conversationId: conversation.id }, { headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
  } catch (error: unknown) {
    if (error instanceof AIRequestGatewayError) {
      return NextResponse.json(error.body, { status: error.status, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }
    warn('Error creating conversation', { error: error instanceof Error ? error.name : 'unknown' });
    return NextResponse.json({ error: 'Unable to start a conversation right now.', code: 'chat_start_failed' }, { status: 500, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
  }
}
