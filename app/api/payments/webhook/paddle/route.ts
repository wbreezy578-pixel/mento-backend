import { NextResponse } from 'next/server';
import { processPaddleWebhook } from '../../../../../services/paddleWebhookService';

export async function POST(req: Request) {
  const signature = req.headers.get('paddle-signature')?.trim() ?? '';
  const rawPayload = await req.text();
  try {
    const result = await processPaddleWebhook(rawPayload, signature);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Paddle webhook processing failed';
    const status = /signature|required/i.test(message) ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
