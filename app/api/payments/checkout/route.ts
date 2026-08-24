import { NextResponse } from 'next/server';
import { getUserFromRequest } from '../../../lib/auth';
import { getPaddleProPriceId, getPaddleClientToken, getPaddleEnv, getPaddleTopUp50PriceId, getPaddleTopUp100PriceId } from '../../../../lib/env';
import { startPayment } from '../../../../services/paymentService';
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
    // Parse request body to get the plan selection
    const body = await req.json();
    const plan = String(body?.plan ?? 'pro').toLowerCase().trim();

    // Validate and resolve the plan to the correct price ID and product type
    let priceId: string;
    let paymentType: 'SUBSCRIPTION' | 'TOP_UP';
    let amountUsd: number;
    let description: string;

    switch (plan) {
      case 'pro':
        priceId = getPaddleProPriceId();
        paymentType = 'SUBSCRIPTION';
        amountUsd = 29; // Actual amount will come from Paddle
        description = 'Paddle Pro subscription checkout initiated';
        break;

      case 'topup_50':
        priceId = getPaddleTopUp50PriceId();
        paymentType = 'TOP_UP';
        amountUsd = 10; // Actual amount will come from Paddle
        description = 'Paddle $10 top-up (50 live tutor minutes) checkout initiated';
        break;

      case 'topup_100':
        priceId = getPaddleTopUp100PriceId();
        paymentType = 'TOP_UP';
        amountUsd = 20; // Actual amount will come from Paddle
        description = 'Paddle $20 top-up (100 live tutor minutes) checkout initiated';
        break;

      default:
        return NextResponse.json({ error: `Invalid plan: ${plan}. Must be one of: pro, topup_50, topup_100` }, { status: 400 });
    }

    const clientToken = getPaddleClientToken();
    const environment = getPaddleEnv();

    // Create the payment transaction with metadata containing the plan and price ID
    const tx = await startPayment({
      userId: user.id,
      provider: 'PADDLE',
      type: paymentType,
      amountUsd,
      currency: 'USD',
      description,
      metadata: { plan, priceId },
    });

    const passthrough = JSON.stringify({ mentoUserId: user.id, transactionId: tx.id });

    return NextResponse.json({
      priceId,
      environment,
      clientToken,
      transactionId: tx.id,
      passthrough,
      plan,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to initialize checkout';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
