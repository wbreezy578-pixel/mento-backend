import { NextResponse } from 'next/server';
import { getUserFromRequest } from '../../../../lib/auth';
import { prisma } from '../../../../../lib/prisma';
import logger from '../../../../../lib/logger';
import { ensureCooldown, ensureSlidingWindow } from '../../../../../lib/rateLimiter';

const MAX_EDIT_LENGTH = 8_000;
const EDIT_COOLDOWN_MS = 1_000;
const EDIT_WINDOW_LIMIT = 30;
const EDIT_WINDOW_SECONDS = 15 * 60;

/**
 * POST /api/chat/message/edit
 * Edit the text of a message in a conversation (auth required)
 */
export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body: { messageId?: unknown; text?: unknown };
    try {
      body = await req.json() as { messageId?: unknown; text?: unknown };
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { messageId, text } = body;

    if (typeof messageId !== 'string' || !messageId.trim() || messageId.length > 128) {
      return NextResponse.json({ error: 'Invalid messageId' }, { status: 400 });
    }
    const normalizedMessageId = messageId.trim();

    if (typeof text !== 'string' || !text.trim()) {
      return NextResponse.json({ error: 'Invalid text' }, { status: 400 });
    }
    // Match normal chat submission: canonical Unicode normalization, trim,
    // and the same 8,000-character ceiling before anything reaches storage.
    const normalizedText = text.normalize('NFC').trim();
    if (normalizedText.length > MAX_EDIT_LENGTH) {
      return NextResponse.json({ error: `Message must be ${MAX_EDIT_LENGTH.toLocaleString()} characters or fewer` }, { status: 413 });
    }

    const rateLimit = await ensureCooldown(`chat-edit:${user.id}`, EDIT_COOLDOWN_MS);
    if (!rateLimit.ok) {
      return NextResponse.json(
        { error: 'Please wait a moment before editing another message.' },
        { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfterSec ?? 1) } },
      );
    }
    const editWindow = await ensureSlidingWindow(
      `chat-edit:${user.id}`,
      EDIT_WINDOW_LIMIT,
      EDIT_WINDOW_SECONDS,
      'rl:chat-edit',
    );
    if (!editWindow.ok) {
      return NextResponse.json(
        { error: 'Too many message edits. Please wait before trying again.' },
        { status: 429, headers: { 'Retry-After': String(editWindow.retryAfterSec ?? EDIT_WINDOW_SECONDS) } },
      );
    }

    // Fetch the message to verify conversation ownership
    const message = await prisma.conversationMessage.findUnique({
      where: { id: normalizedMessageId },
      include: { conversation: { select: { userId: true } } }
    });

    if (!message) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    // Verify user owns the conversation
    if (message.conversation.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Only allow editing user messages
    if (message.role !== 'user') {
      return NextResponse.json({ error: 'Cannot edit assistant messages' }, { status: 400 });
    }

    const { updated, deletedMessageIds } = await prisma.$transaction(async (tx) => {
      const staleMessages = await tx.conversationMessage.findMany({
        where: {
          conversationId: message.conversationId,
          createdAt: { gt: message.createdAt },
        },
        select: { id: true },
      });
      if (staleMessages.length > 0) {
        await tx.conversationMessage.deleteMany({
          where: { id: { in: staleMessages.map((item) => item.id) } },
        });
      }
      const updatedMessage = await tx.conversationMessage.update({
        where: { id: normalizedMessageId },
        data: { text: normalizedText, content: normalizedText, status: 'completed' },
      });
      await tx.conversation.update({
        where: { id: message.conversationId },
        data: { updatedAt: new Date(), summary: null, summaryUpdatedAt: null },
      });
      return { updated: updatedMessage, deletedMessageIds: staleMessages.map((item) => item.id) };
    });

    return NextResponse.json({ success: true, message: updated, deletedMessageIds });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    logger.error('Edit message failed', { error: err });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
