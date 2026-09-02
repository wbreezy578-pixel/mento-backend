import { OAuth2Client } from 'google-auth-library';
import { NextResponse } from 'next/server';
import { prisma } from '../../../../../lib/prisma';
import { getRequiredEnv } from '../../../../../lib/env';
import { processGooglePlayRtdn } from '../../../../../services/nativeStoreService';

export async function POST(req: Request) {
  try {
    const authorization = req.headers.get('authorization') ?? '';
    const idToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!idToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const audience = getRequiredEnv('GOOGLE_PLAY_RTDN_AUDIENCE');
    const expectedEmail = getRequiredEnv('GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL').trim();
    const ticket = await new OAuth2Client().verifyIdToken({ idToken, audience });
    const payload = ticket.getPayload();
    if (payload?.email_verified !== true || payload.email !== expectedEmail) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const envelope = await req.json() as { message?: { messageId?: unknown; data?: unknown; publishTime?: unknown } };
    const messageId = typeof envelope.message?.messageId === 'string' ? envelope.message.messageId : '';
    const data = typeof envelope.message?.data === 'string' ? envelope.message.data : '';
    if (!messageId || !data) return NextResponse.json({ error: 'Invalid Pub/Sub message.' }, { status: 400 });
    const parsedPublishTime = typeof envelope.message?.publishTime === 'string' ? new Date(envelope.message.publishTime) : null;
    const occurredAt = parsedPublishTime && !Number.isNaN(parsedPublishTime.getTime()) ? parsedPublishTime : new Date();
    let event;
    try {
      event = await prisma.paymentWebhookEvent.create({
        data: {
          provider: 'GOOGLE_PLAY',
          eventId: messageId,
          notificationId: messageId,
          eventType: 'RTDN',
          occurredAt,
          rawPayload: JSON.stringify(envelope),
          status: 'PROCESSING',
          attempts: 1,
        },
      });
    } catch (error) {
      if (!(typeof error === 'object' && error && 'code' in error && error.code === 'P2002')) throw error;
      const existing = await prisma.paymentWebhookEvent.findUnique({ where: { provider_eventId: { provider: 'GOOGLE_PLAY', eventId: messageId } } });
      if (existing?.status === 'PROCESSED' || existing?.status === 'PROCESSING') return new NextResponse(null, { status: 204 });
      if (!existing) throw error;
      const claimed = await prisma.paymentWebhookEvent.updateMany({
        where: { id: existing.id, status: 'FAILED' },
        data: { status: 'PROCESSING', attempts: { increment: 1 }, error: null },
      });
      if (claimed.count === 0) return new NextResponse(null, { status: 204 });
      event = await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { id: existing.id } });
    }
    try {
      const result = await processGooglePlayRtdn(data);
      await prisma.paymentWebhookEvent.update({ where: { id: event.id }, data: { status: 'PROCESSED', processedAt: new Date(), attempts: { increment: 1 }, eventType: result.type, error: null } });
      return new NextResponse(null, { status: 204 });
    } catch (error) {
      await prisma.paymentWebhookEvent.update({ where: { id: event.id }, data: { status: 'FAILED', attempts: { increment: 1 }, error: (error instanceof Error ? error.message : String(error)).slice(0, 1000) } });
      throw error;
    }
  } catch {
    return NextResponse.json({ error: 'RTDN processing failed.' }, { status: 500 });
  }
}
