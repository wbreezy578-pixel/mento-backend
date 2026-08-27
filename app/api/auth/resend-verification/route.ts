import { NextResponse } from 'next/server';
import { createEmailActionToken } from '../../../../lib/authSession';
import { prisma } from '../../../../lib/prisma';
import { authRateLimitSubject, getClientIp, normalizeEmail } from '../../../lib/auth';
import { ensureSlidingWindow } from '../../../../lib/rateLimiter';
import { sendVerificationEmail } from '../../../../services/transactionalEmailService';

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const email = normalizeEmail(typeof body.email === 'string' ? body.email : '');
  if (!email) return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 });
  const limit = await ensureSlidingWindow(`verify-email:${getClientIp(req)}:${authRateLimitSubject(email)}`, 3, 15 * 60);
  if (!limit.ok) return NextResponse.json({ error: 'Please wait before requesting another email.' }, { status: 429 });
  const user = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' }, emailVerified: false, authProvider: 'email' } });
  if (user) {
    const token = await createEmailActionToken({ userId: user.id, purpose: 'VERIFY_EMAIL', expiresInMinutes: 60 });
    await sendVerificationEmail(user.email, token);
  }
  return NextResponse.json({ ok: true, message: 'If the account needs verification, a new email has been sent.' });
}
