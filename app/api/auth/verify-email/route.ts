import { NextResponse } from 'next/server';
import { hashToken } from '../../../../lib/authSession';
import { prisma } from '../../../../lib/prisma';
import { authRateLimitSubject, getClientIp, recordSecurityEvent } from '../../../lib/auth';
import { ensureSlidingWindow } from '../../../../lib/rateLimiter';
import { buildCorsHeaders } from '../../../../lib/securityHeaders';

const CORS_METHODS = 'POST, OPTIONS';
const responseHeaders = (req: Request) => ({ ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS });

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: responseHeaders(req) });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token) return NextResponse.json({ error: 'Verification link is invalid.' }, { status: 400, headers: responseHeaders(req) });
  const tokenHash = hashToken(token);
  const [ipLimit, tokenLimit] = await Promise.all([
    ensureSlidingWindow(`verify-email:ip:${getClientIp(req)}`, 20, 15 * 60),
    ensureSlidingWindow(`verify-email:token:${authRateLimitSubject(tokenHash)}`, 5, 15 * 60),
  ]);
  if (!ipLimit.ok || !tokenLimit.ok) return NextResponse.json({ error: 'Too many verification attempts. Please try again later.' }, { status: 429, headers: responseHeaders(req) });

  const userId = await prisma.$transaction(async (tx) => {
    const record = await tx.emailActionToken.findFirst({
      where: { tokenHash, purpose: 'VERIFY_EMAIL', usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, userId: true },
    });
    if (!record) return null;
    const claimed = await tx.emailActionToken.updateMany({
      where: { id: record.id, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date(), revokedAt: new Date() },
    });
    if (claimed.count !== 1) return null;
    await tx.user.update({ where: { id: record.userId }, data: { emailVerified: true, accountStatus: 'ACTIVE', credentialsChangedAt: new Date() } });
    return record.userId;
  });
  if (!userId) return NextResponse.json({ error: 'Verification link is invalid or expired.' }, { status: 401, headers: responseHeaders(req) });
  await recordSecurityEvent(userId, 'email_verified');
  return NextResponse.json({ ok: true, message: 'Email verified. You can now sign in.' }, { headers: responseHeaders(req) });
}
