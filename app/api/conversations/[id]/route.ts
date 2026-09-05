import { NextResponse } from 'next/server';
import { getUserFromRequest } from '../../../lib/auth';
import { deleteConversation, validateConversationOwnership } from '../../../../lib/conversationDb';
import { info, warn } from '../../../../lib/logger';
import { buildRateLimitHeaders, enforceChatEndpointRateLimit } from '../../../../lib/chatRateLimits';

import { buildCorsHeaders } from '../../../../lib/securityHeaders';
import { acquireAIGenerationLock, releaseAIGenerationLock } from '../../../../lib/aiGenerationLock';
import { randomUUID } from 'node:crypto';

const CORS_METHODS = 'DELETE, OPTIONS';

export async function OPTIONS(req: Request) {
  info('Conversation delete preflight', {
    origin: req.headers.get('origin') ?? null,
  });
  return new NextResponse(null, {
    status: 204,
    headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS },
  });
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const { id: conversationId } = await context.params;

    const owns = await validateConversationOwnership(conversationId, user.id);
    if (!owns) {
      warn('Unauthorized delete attempt', { userId: user.id, conversationId });
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const rateLimit = await enforceChatEndpointRateLimit(user.id, 'delete-conversation');
    if (!rateLimit.ok) {
      return NextResponse.json(
        { error: 'Too many conversation deletions. Please try again later.', code: 'rate_limit_exceeded', retryAfterSec: rateLimit.retryAfterSec },
        { status: 429, headers: { ...buildCorsHeaders(req.headers.get('origin')), ...buildRateLimitHeaders(rateLimit.retryAfterSec), 'Access-Control-Allow-Methods': CORS_METHODS } },
      );
    }

    const lockOwner = `${user.id}:conversation-delete:${randomUUID()}`;
    if (!await acquireAIGenerationLock(conversationId, lockOwner)) {
      return NextResponse.json(
        { error: 'This conversation is busy. Wait for the current response to finish.', code: 'generation_in_progress' },
        { status: 409, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } },
      );
    }
    try {
      await deleteConversation(conversationId);
    } finally {
      await releaseAIGenerationLock(conversationId, lockOwner).catch(() => undefined);
    }
    return NextResponse.json({ success: true }, { headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    warn('Error deleting conversation', { error: message });
    return NextResponse.json({ error: 'Unable to delete the conversation.', code: 'conversation_delete_failed' }, { status: 500, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
  }
}
