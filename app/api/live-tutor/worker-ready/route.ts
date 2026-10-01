import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { prisma } from '../../../../lib/prisma';
import { markLiveTutorSessionUsable } from '../../../../services/simliService';
import logger from '../../../../lib/logger';

export const runtime = 'nodejs';

function hasValidWorkerSecret(request: NextRequest): boolean {
  const expected = process.env.MENTO_LIVE_TUTOR_WORKER_CALLBACK_SECRET?.trim();
  const supplied = request.headers.get('x-mento-live-tutor-worker-secret')?.trim();
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

/**
 * Only the dispatched LiveKit worker may move a durable session into billable
 * time. The worker calls this after the authenticated mobile participant has
 * reported all strict media readiness checkpoints over the room data channel.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!hasValidWorkerSecret(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => null) as { streamId?: unknown } | null;
  const streamId = typeof body?.streamId === 'string' ? body.streamId.trim() : '';
  if (!streamId || streamId.length > 200) return NextResponse.json({ error: 'Invalid session' }, { status: 400 });

  const durable = await prisma.liveTutorSession.findUnique({ where: { streamId }, select: { userId: true } });
  if (!durable) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  const usable = await markLiveTutorSessionUsable(streamId, durable.userId);
  if (!usable) return NextResponse.json({ error: 'Session is no longer usable' }, { status: 409 });
  logger.info('[LiveTutorLifecycle] worker_confirmed_session_usable', { streamId, userId: durable.userId, category: 'live_tutor_usable' });
  return NextResponse.json({ expiresAt: usable.expiresAt.toISOString() });
}
