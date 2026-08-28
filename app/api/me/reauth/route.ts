import { NextResponse } from 'next/server';
import logger from '../../../../lib/logger';
import { getUserFromRequest, recordSecurityEvent, verifyPassword } from '../../../lib/auth';
import { ensureSlidingWindow } from '../../../../lib/rateLimiter';

const authJson = (body: unknown, init: ResponseInit = {}) => NextResponse.json(body, {
  ...init,
  headers: { 'Cache-Control': 'no-store', ...(init.headers ?? {}) },
});

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return authJson({ error: 'Unauthorized' }, { status: 401 });
    }
    const limit = await ensureSlidingWindow(`password-reauth:${user.id}`, 5, 15 * 60);
    if (!limit.ok) return authJson({ error: 'Too many confirmation attempts. Please try again later.' }, { status: 429 });

    const { password } = await req.json();
    if (typeof password !== 'string' || !password.trim()) {
      return authJson({ error: 'Password is required.' }, { status: 400 });
    }

    const passwordMatches = await verifyPassword(password, user.password);
    if (!passwordMatches) {
      await recordSecurityEvent(user.id, 'password_reauthentication_rejected');
      return authJson({ error: 'Incorrect password.' }, { status: 401 });
    }

    await recordSecurityEvent(user.id, 'password_reauthentication_completed');
    return authJson({ ok: true, success: true });
  } catch (error: unknown) {
    logger.error('Password reauthentication failed', { error });
    return authJson({ error: 'Unable to confirm your password right now.' }, { status: 500 });
  }
}
