import { NextResponse } from 'next/server';
import { prisma } from '../../../../../lib/prisma';
import { processAppleStoreNotification } from '../../../../../services/nativeStoreService';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as { signedPayload?: unknown } | null;
  if (typeof body?.signedPayload !== 'string' || !body.signedPayload) {
    return NextResponse.json({ error: 'Invalid App Store notification.' }, { status: 400 });
  }
  try {
    const result = await processAppleStoreNotification(body.signedPayload);
    await prisma.paymentWebhookEvent.upsert({
      where: { provider_eventId: { provider: 'APPLE_APP_STORE', eventId: result.eventId } },
      create: { provider: 'APPLE_APP_STORE', eventId: result.eventId, notificationId: result.eventId, eventType: result.type, occurredAt: new Date(), rawPayload: JSON.stringify(body), status: 'PROCESSED', attempts: 1, processedAt: new Date() },
      update: { eventType: result.type, status: 'PROCESSED', attempts: { increment: 1 }, processedAt: new Date(), error: null },
    });
    return new NextResponse(null, { status: 200 });
  } catch {
    return NextResponse.json({ error: 'App Store notification verification failed.' }, { status: 400 });
  }
}
