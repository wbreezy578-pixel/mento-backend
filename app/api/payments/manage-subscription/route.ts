import { NextResponse } from 'next/server';
import { getUserFromRequest } from '../../../lib/auth';
import { createPaddleCustomerPortalForUser } from '../../../../services/paddleService';

export async function POST(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    return NextResponse.json({ url: await createPaddleCustomerPortalForUser(user.id) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to open subscription management.' }, { status: 400 });
  }
}
