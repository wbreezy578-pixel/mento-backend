import { NextResponse } from 'next/server';
import { getUserFromRequest } from '../../lib/auth';
import { listPayments, getPayment, getLedgerSummary } from '../../../services/paymentService';

export async function GET(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const paymentId = url.searchParams.get('paymentId');
  if (paymentId) return NextResponse.json(await getPayment(user.id, paymentId));
  if (url.searchParams.get('ledger') === 'true') return NextResponse.json(await getLedgerSummary(user.id));
  return NextResponse.json(await listPayments(user.id));
}

export async function POST(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ error: 'Create payments through /api/payments/checkout.' }, { status: 405 });
}

export async function PUT() {
  return NextResponse.json({ error: 'Payment finalization is webhook-only.' }, { status: 405 });
}

export async function PATCH() {
  return NextResponse.json({ error: 'Unsupported payment operation.' }, { status: 405 });
}
