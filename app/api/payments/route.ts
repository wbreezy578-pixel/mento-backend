import { NextResponse } from 'next/server';
import { getUserFromRequest } from '../../lib/auth';
import { listPayments, startPayment, getPayment, getLedgerSummary, finalizePayment, verifyWebhookSignature, type PaymentProvider, type PaymentStatus } from '../../../services/paymentService';
import { processPaddleWebhook } from '../../../services/paddleWebhookService';

async function requireAuthenticatedUser(req: Request) {
  return await getUserFromRequest(req);
}

export async function GET(req: Request) {
  const user = await requireAuthenticatedUser(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const paymentId = url.searchParams.get('paymentId');
  const ledger = url.searchParams.get('ledger') === 'true';

  if (paymentId) {
    const payment = await getPayment(user.id, paymentId);
    return NextResponse.json(payment);
  }

  if (ledger) {
    return NextResponse.json(await getLedgerSummary(user.id));
  }

  return NextResponse.json(await listPayments(user.id));
}

export async function POST(req: Request) {
  const payload = await req.text();
  const paddleSignature = req.headers.get('paddle-signature')?.trim() || '';

  if (paddleSignature) {
    const provider = 'PADDLE' as PaymentProvider;
    const ok = await verifyWebhookSignature({ payload, signature: paddleSignature, provider });
    if (!ok) {
      return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 401 });
    }

    try {
      const result = await processPaddleWebhook(payload, paddleSignature);
      if (result && (result.ok || result.duplicate || result.unmapped)) {
        return NextResponse.json({ ok: true });
      }
      return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Processing error';
      const status = /ownership|conflict/i.test(message) ? 409 : 500;
      return NextResponse.json({ error: message }, { status });
    }
  }

  let body: any = {};
  try {
    body = payload ? JSON.parse(payload) : {};
  } catch {
    body = {};
  }

  // Normal authenticated POST for creating payments
  const user = await requireAuthenticatedUser(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const normalized = {
      userId: user.id,
      provider: String(body?.provider || 'PADDLE').toUpperCase() as PaymentProvider,
      type: String(body?.type || 'SUBSCRIPTION').toUpperCase() as 'SUBSCRIPTION' | 'TOP_UP',
      amountUsd: Number(body?.amountUsd ?? 15),
      currency: String(body?.currency || 'USD'),
      description: body?.description ? String(body.description) : undefined,
      idempotencyKey: body?.idempotencyKey ? String(body.idempotencyKey) : undefined,
      metadata: body?.metadata && typeof body.metadata === 'object' ? body.metadata : {},
      providerCustomerId: body?.providerCustomerId ? String(body.providerCustomerId) : undefined,
      providerSubscriptionId: body?.providerSubscriptionId ? String(body.providerSubscriptionId) : undefined,
      providerTransactionId: body?.providerTransactionId ? String(body.providerTransactionId) : undefined,
    };

    const payment = await startPayment(normalized);
    return NextResponse.json(payment);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to create payment' }, { status: 400 });
  }
}

export async function PUT(req: Request) {
  const user = await requireAuthenticatedUser(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const payment = await finalizePayment({
      transactionId: String(body?.transactionId || ''),
      provider: String(body?.provider || 'PADDLE').toUpperCase() as PaymentProvider,
      status: String(body?.status || 'SUCCEEDED').toUpperCase() as PaymentStatus,
      providerTransactionId: body?.providerTransactionId ? String(body.providerTransactionId) : undefined,
      providerSubscriptionId: body?.providerSubscriptionId ? String(body.providerSubscriptionId) : undefined,
      providerPayload: body?.providerPayload && typeof body.providerPayload === 'object' ? body.providerPayload : undefined,
      failureReason: body?.failureReason ? String(body.failureReason) : undefined,
      idempotencyKey: body?.idempotencyKey ? String(body.idempotencyKey) : undefined,
    });

    return NextResponse.json(payment);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to finalize payment' }, { status: 400 });
  }
}

export async function PATCH(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    const payload = await req.text();
    const paddleSignature = req.headers.get('paddle-signature')?.trim() || '';

    if (paddleSignature) {
      const ok = await verifyWebhookSignature({ payload, signature: paddleSignature, provider: 'PADDLE' });
      if (!ok) {
        return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 401 });
      }

      try {
        const result = await processPaddleWebhook(payload, paddleSignature);
        if (result && (result.ok || result.duplicate || result.unmapped)) {
          return NextResponse.json({ ok: true });
        }
        return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Processing error';
        const status = /ownership|conflict/i.test(message) ? 409 : 500;
        return NextResponse.json({ error: message }, { status });
      }
    }

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = payload ? JSON.parse(payload) : {};
    return NextResponse.json({ error: 'Unsupported PATCH payload' }, { status: 400 });
  } catch {
    return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 401 });
  }
}
