import { NextResponse } from 'next/server';
import { buildCorsHeaders } from '../../../../lib/securityHeaders';
import { hashToken } from '../../../../lib/authSession';
import { authRateLimitSubject, getClientIp, hashPassword, normalizeEmail, recordSecurityEvent, validatePasswordStrength } from '../../../lib/auth';
import { ensureSlidingWindow } from '../../../../lib/rateLimiter';
import logger from '../../../../lib/logger';
import { sendPasswordChangedEmail } from '../../../../services/transactionalEmailService';

const CORS_METHODS = 'POST, OPTIONS';

export async function OPTIONS(req: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS },
  });
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    const confirmPassword = typeof body?.confirmPassword === 'string' ? body.confirmPassword : '';

    if (!token || !password || !confirmPassword) {
      return NextResponse.json({ error: 'A valid reset token and password are required.' }, { status: 400, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    if (password !== confirmPassword) {
      return NextResponse.json({ error: 'Passwords must match.' }, { status: 400, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const passwordPolicy = validatePasswordStrength(password);
    if (!passwordPolicy.isValid) {
      return NextResponse.json({ error: passwordPolicy.reasons.join(' ') }, { status: 400, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const { prisma } = await import('../../../../lib/prisma');
    const tokenHash = hashToken(token);
    const clientIp = getClientIp(req);
    const [ipLimit, tokenLimit] = await Promise.all([
      ensureSlidingWindow(`reset-password:ip:${clientIp}`, 20, 15 * 60),
      ensureSlidingWindow(`reset-password:token:${authRateLimitSubject(tokenHash)}`, 5, 15 * 60),
    ]);
    if (!ipLimit.ok || !tokenLimit.ok) {
      return NextResponse.json({ error: 'Too many password reset attempts. Please try again later.' }, { status: 429, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    // Reject invalid tokens before running the deliberately expensive bcrypt hash.
    // The token is still claimed atomically in the transaction below.
    const candidate = await prisma.passwordResetToken.findFirst({
      where: { tokenHash, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true },
    });
    if (!candidate) {
      return NextResponse.json({ error: 'Invalid or expired reset token.' }, { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const hashedPassword = await hashPassword(password);
    const resetUser = await prisma.$transaction(async (tx) => {
      const resetRecord = await tx.passwordResetToken.findFirst({
        where: { id: candidate.id, tokenHash, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        include: { user: true },
      });
      if (!resetRecord) return null;
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: resetRecord.id, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date(), revokedAt: new Date() },
      });
      if (claimed.count !== 1) return null;
      await tx.user.update({
        where: { id: resetRecord.user.id },
        data: { password: hashedPassword, email: normalizeEmail(resetRecord.user.email), emailVerified: true, credentialsChangedAt: new Date(), accountStatus: 'ACTIVE', failedLoginAttempts: 0, lastFailedLoginAt: null, lockedAt: null },
      });
      await tx.session.updateMany({
        where: { userId: resetRecord.user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return { id: resetRecord.user.id, email: resetRecord.user.email };
    });
    if (!resetUser) return NextResponse.json({ error: 'Invalid or expired reset token.' }, { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });

    await recordSecurityEvent(resetUser.id, 'password_reset_completed');
    await sendPasswordChangedEmail(resetUser.email).catch((error) => {
      logger.warn('Password reset security notice could not be sent', { errorName: error instanceof Error ? error.name : 'unknown' });
    });

    return NextResponse.json({ ok: true }, { status: 200, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
  } catch (error) {
    logger.error('Password reset failed', { errorName: error instanceof Error ? error.name : 'unknown' });
    return NextResponse.json({ error: 'Unable to reset password.' }, { status: 500, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
  }
}
