import { NextResponse } from 'next/server';
import { getUserFromRequest } from '../../../lib/auth';
import { createConversationWithInitialMessage } from '../../../../lib/conversationDb';
import { info, warn } from '../../../../lib/logger';
import { buildCorsHeaders } from '../../../../lib/securityHeaders';

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
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const body = await req.json().catch(() => null) as { initialMessage?: unknown; requestId?: unknown } | null;
    const initialMessage = typeof body?.initialMessage === 'string' ? body.initialMessage.trim() : '';
    if (!initialMessage || initialMessage.length > 20_000) {
      return NextResponse.json({ error: 'A valid initial message is required.' }, { status: 400, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }
    const requestId = typeof body?.requestId === 'string' ? body.requestId.trim().slice(0, 200) : undefined;
    const conversation = await createConversationWithInitialMessage(user.id, initialMessage, { requestId });
    info('New conversation created with initial message', { category: 'conversation_created' });

    return NextResponse.json({ conversationId: conversation.id }, { headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    warn('Error creating conversation', { error: message });
    return NextResponse.json({ error: message }, { status: 500, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
  }
}
