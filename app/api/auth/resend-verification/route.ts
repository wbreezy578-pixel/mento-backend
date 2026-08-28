import { NextResponse } from 'next/server';
import { createEmailActionToken } from '../../../../lib/authSession';
import { prisma } from '../../../../lib/prisma';
import { authRateLimitSubject, getClientIp, normalizeEmail } from '../../../lib/auth';
import { ensureSlidingWindow } from '../../../../lib/rateLimiter';
import { sendVerificationEmail } from '../../../../services/transactionalEmailService';
import logger from '../../../../lib/logger';

export async function POST(req: Request) {
  const startedAt = Date.now();
  const body = await req.json().catch(() => ({}));
  const email = normalizeEmail(typeof body.email === 'string' ? body.email : '');
  if (!email) return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 });
  const clientIp = getClientIp(req);
  const [ipLimit, accountLimit] = await Promise.all([
    ensureSlidingWindow(`verify-email:ip:${clientIp}`, 15, 15 * 60),
    ensureSlidingWindow(`verify-email:account:${authRateLimitSubject(email)}`, 3, 15 * 60),
  ]);
  if (!ipLimit.ok || !accountLimit.ok) return NextResponse.json({ error: 'Please wait before requesting another email.' }, { status: 429 });
  const user = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' }, emailVerified: false, authProvider: 'email' } });
  if (user) {
    const token = await createEmailActionToken({ userId: user.id, purpose: 'VERIFY_EMAIL', expiresInMinutes: 60 });
    await sendVerificationEmail(user.email, token).catch((error) => {
      logger.warn('Verification email delivery failed', { error });
    });
  }
  const remainingDelayMs = 650 - (Date.now() - startedAt);
  if (remainingDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingDelayMs));
  return NextResponse.json({ ok: true, message: 'If the account needs verification, a new email has been sent.' });
}
