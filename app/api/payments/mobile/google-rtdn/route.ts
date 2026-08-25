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
    const ticket = await new OAuth2Client().verifyIdToken({ idToken, audience });
    const payload = ticket.getPayload();
    const expectedEmail = process.env.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL?.trim();
    if (!payload?.email_verified || (expectedEmail && payload.email !== expectedEmail)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const envelope = await req.json() as { message?: { messageId?: unknown; data?: unknown; publishTime?: unknown } };
    const messageId = typeof envelope.message?.messageId === 'string' ? envelope.message.messageId : '';
    const data = typeof envelope.message?.data === 'string' ? envelope.message.data : '';
    if (!messageId || !data) return NextResponse.json({ error: 'Invalid Pub/Sub message.' }, { status: 400 });
    const event = await prisma.paymentWebhookEvent.upsert({
      where: { provider_eventId: { provider: 'GOOGLE_PLAY', eventId: messageId } },
      create: { provider: 'GOOGLE_PLAY', eventId: messageId, notificationId: messageId, eventType: 'RTDN', occurredAt: typeof envelope.message?.publishTime === 'string' ? new Date(envelope.message.publishTime) : new Date(), rawPayload: JSON.stringify(envelope) },
      update: {},
    });
    if (event.status === 'PROCESSED') return new NextResponse(null, { status: 204 });
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
