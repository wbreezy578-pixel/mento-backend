import { NextResponse } from 'next/server';
import { buildCorsHeaders } from '../../../../lib/securityHeaders';
import { createPasswordResetToken } from '../../../../lib/authSession';
import { authRateLimitSubject, getClientIp, normalizeEmail, recordSecurityEvent } from '../../../lib/auth';
import { ensureSlidingWindow } from '../../../../lib/rateLimiter';
import logger from '../../../../lib/logger';
import { sendPasswordResetEmail } from '../../../../services/transactionalEmailService';

const CORS_METHODS = 'POST, OPTIONS';

export async function OPTIONS(req: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS },
  });
}

export async function POST(req: Request) {
  const startedAt = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    const email = typeof body?.email === 'string' ? body.email : '';
    const normalizedEmail = normalizeEmail(email);

    if (!normalizedEmail) {
      return NextResponse.json({ error: 'A valid email is required.' }, { status: 400, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const clientIp = getClientIp(req);
    const [ipLimit, accountLimit] = await Promise.all([
      ensureSlidingWindow(`forgot-password:ip:${clientIp}`, 20, 15 * 60),
      ensureSlidingWindow(`forgot-password:account:${authRateLimitSubject(normalizedEmail)}`, 5, 15 * 60),
    ]);
    if (!ipLimit.ok || !accountLimit.ok) {
      return NextResponse.json({ error: 'Too many password reset requests. Please try again later.' }, { status: 429, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const { prisma } = await import('../../../../lib/prisma');
    const user = await prisma.user.findFirst({
      where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
      select: { id: true, email: true, authProvider: true },
    });

    if (user) {
      const acceptsReset = user.authProvider === 'email' || user.authProvider === 'mixed';
      if (acceptsReset) {
        const token = await createPasswordResetToken(user.id);
        await sendPasswordResetEmail(user.email, token).catch((error) => {
          logger.warn('Password reset email delivery failed', { error });
        });
      }
      await recordSecurityEvent(user.id, 'password_reset_requested', { acceptsReset, networkSubject: authRateLimitSubject(clientIp) });
    } else {
      await recordSecurityEvent(null, 'password_reset_requested', { accountSubject: authRateLimitSubject(normalizedEmail), networkSubject: authRateLimitSubject(clientIp), userFound: false });
    }

    const minimumResponseMs = 650;
    const remainingDelayMs = minimumResponseMs - (Date.now() - startedAt);
    if (remainingDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingDelayMs));

    return NextResponse.json({ ok: true, message: 'If an account exists for that email, a password reset link has been sent.' }, {
      status: 200,
      headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS },
    });
  } catch (error) {
    logger.error('Forgot password failed', { error });
    return NextResponse.json({ error: 'Unable to process password reset request.' }, { status: 500, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
  }
}
