import { NextResponse } from 'next/server';
import { getUserFromRequest } from '../../../../../app/lib/auth';
import { buildCorsHeaders } from '../../../../../lib/securityHeaders';
import { verifyAppleStorePurchase, verifyGooglePlayPurchase } from '../../../../../services/nativeStoreService';

function responseHeaders(origin: string | null): Record<string, string> {
  return { ...buildCorsHeaders(origin), 'Content-Type': 'application/json' };
}

export async function POST(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: responseHeaders(req.headers.get('origin')) });

  try {
    const body = await req.json() as { platform?: unknown; productId?: unknown; purchaseToken?: unknown };
    if (body.platform !== 'android' && body.platform !== 'ios') {
      return NextResponse.json({ error: 'Unsupported store platform.' }, { status: 400, headers: responseHeaders(req.headers.get('origin')) });
    }
    if (typeof body.productId !== 'string' || typeof body.purchaseToken !== 'string') {
      return NextResponse.json({ error: 'productId and purchaseToken are required.' }, { status: 400, headers: responseHeaders(req.headers.get('origin')) });
    }
    const result = body.platform === 'android'
      ? await verifyGooglePlayPurchase({ userId: user.id, productId: body.productId, purchaseToken: body.purchaseToken })
      : await verifyAppleStorePurchase({ userId: user.id, productId: body.productId, signedTransaction: body.purchaseToken });
    return NextResponse.json({ success: true, purchase: result }, { headers: responseHeaders(req.headers.get('origin')) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Purchase verification failed.';
    const status = /invalid|different|not active|not completed|ownership|already associated/i.test(message) ? 400 : 502;
    return NextResponse.json({ error: status === 502 ? 'Store verification is temporarily unavailable. Please try again.' : message }, { status, headers: responseHeaders(req.headers.get('origin')) });
  }
}
