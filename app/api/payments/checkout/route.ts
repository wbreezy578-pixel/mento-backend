import { NextResponse } from 'next/server';
import { getUserFromRequest } from '../../../lib/auth';
import { createPaddleCheckoutForUser, isPaddleCheckoutSku } from '../../../../services/paddleService';
import { buildCorsHeaders } from '../../../../lib/securityHeaders';

const CORS_METHODS = 'POST, OPTIONS';

export async function OPTIONS(req: Request) {
  const corsHeaders = buildCorsHeaders(req.headers.get('origin'));
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...corsHeaders,
      'Access-Control-Allow-Methods': CORS_METHODS,
    },
  });
}

export async function POST(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const plan = String(body?.plan ?? 'pro').toLowerCase().trim();
    if (!isPaddleCheckoutSku(plan)) {
      return NextResponse.json({ error: `Invalid plan: ${plan}. Must be one of: pro, topup_50, topup_100` }, { status: 400 });
    }
    return NextResponse.json(await createPaddleCheckoutForUser(user.id, plan));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to initialize checkout';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
