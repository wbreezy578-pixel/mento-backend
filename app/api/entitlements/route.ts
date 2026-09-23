import { NextResponse } from 'next/server';
import { getUserFromRequest } from '../../lib/auth';
import { getEntitlementSnapshot } from '../../../services/entitlementService';
import logger from '../../../lib/logger';

export async function GET(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const entitlement = await getEntitlementSnapshot(user.id);
    return NextResponse.json({ entitlement });
  } catch (error) {
    logger.error('Entitlement snapshot unavailable', { userId: user.id, errorName: error instanceof Error ? error.name : 'UnknownError' });
    return NextResponse.json({ error: 'Product access is temporarily unavailable.', code: 'entitlement_unavailable', retryable: true }, { status: 503 });
  }
}
