import { NextResponse } from 'next/server';
import { getUserFromRequest } from '../../../../lib/auth';
import { unpinConversation, validateConversationOwnership } from '../../../../../lib/conversationDb';
import { warn } from '../../../../../lib/logger';
import { buildRateLimitHeaders, enforceChatEndpointRateLimit } from '../../../../../lib/chatRateLimits';

/**
 * POST /api/conversations/[id]/unpin
 *
 * Unpin a conversation.
 *
 * Response:
 *   { success: true }
 */

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const rateLimit = await enforceChatEndpointRateLimit(user.id, 'pin');
    if (!rateLimit.ok) {
      return NextResponse.json(
        { error: 'Too many pin requests. Please try again later.', code: 'rate_limit_exceeded', retryAfterSec: rateLimit.retryAfterSec },
        { status: 429, headers: buildRateLimitHeaders(rateLimit.retryAfterSec) },
      );
    }

    const { id: conversationId } = await context.params;

    // Validate ownership
    const owns = await validateConversationOwnership(conversationId, user.id);
    if (!owns) {
      warn('Unauthorized unpin attempt', { userId: user.id, conversationId });
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    await unpinConversation(conversationId);

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    warn('Error unpinning conversation', { error: message });
    return NextResponse.json({ error: 'Unable to unpin the conversation.', code: 'conversation_unpin_failed' }, { status: 500 });
  }
}
