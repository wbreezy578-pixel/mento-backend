import { NextResponse } from 'next/server';
import logger from '../../../../lib/logger';
import { getUserFromRequest, recordSecurityEvent, verifyPassword } from '../../../lib/auth';
import { ensureSlidingWindow } from '../../../../lib/rateLimiter';

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const limit = await ensureSlidingWindow(`password-reauth:${user.id}`, 5, 15 * 60);
    if (!limit.ok) return NextResponse.json({ error: 'Too many confirmation attempts. Please try again later.' }, { status: 429 });

    const { password } = await req.json();
    if (typeof password !== 'string' || !password.trim()) {
      return NextResponse.json({ error: 'Password is required.' }, { status: 400 });
    }

    const passwordMatches = await verifyPassword(password, user.password);
    if (!passwordMatches) {
      await recordSecurityEvent(user.id, 'password_reauthentication_rejected');
      return NextResponse.json({ error: 'Incorrect password.' }, { status: 401 });
    }

    await recordSecurityEvent(user.id, 'password_reauthentication_completed');
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    logger.error('Password reauthentication failed', { error });
    return NextResponse.json({ error: 'Unable to confirm your password right now.' }, { status: 500 });
  }
}
