import { NextResponse } from 'next/server';
import { hashToken } from '../../../../lib/authSession';
import { prisma } from '../../../../lib/prisma';
import { authRateLimitSubject, getClientIp, normalizeEmail, recordSecurityEvent } from '../../../lib/auth';
import { ensureSlidingWindow } from '../../../../lib/rateLimiter';
import { sendEmailChangedNotice } from '../../../../services/transactionalEmailService';
import { buildCorsHeaders } from '../../../../lib/securityHeaders';

const CORS_METHODS = 'POST, OPTIONS';
const responseHeaders = (req: Request) => ({ ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS });

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: responseHeaders(req) });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token) return NextResponse.json({ error: 'Confirmation link is invalid.' }, { status: 400, headers: responseHeaders(req) });
  const tokenHash = hashToken(token);
  const [ipLimit, tokenLimit] = await Promise.all([
    ensureSlidingWindow(`confirm-email:ip:${getClientIp(req)}`, 20, 15 * 60),
    ensureSlidingWindow(`confirm-email:token:${authRateLimitSubject(tokenHash)}`, 5, 15 * 60),
  ]);
  if (!ipLimit.ok || !tokenLimit.ok) return NextResponse.json({ error: 'Too many confirmation attempts. Please try again later.' }, { status: 429, headers: responseHeaders(req) });

  const result = await prisma.$transaction(async (tx) => {
    const record = await tx.emailActionToken.findFirst({
      where: { tokenHash, purpose: 'CHANGE_EMAIL', usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      include: { user: true },
    });
    const targetEmail = normalizeEmail(record?.targetEmail);
    if (!record || !targetEmail || record.user.pendingEmail !== targetEmail) return { status: 'invalid' as const };
    const existing = await tx.user.findFirst({ where: { email: { equals: targetEmail, mode: 'insensitive' }, id: { not: record.userId } }, select: { id: true } });
    if (existing) return { status: 'conflict' as const };
    const claimed = await tx.emailActionToken.updateMany({
      where: { id: record.id, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date(), revokedAt: new Date() },
    });
    if (claimed.count !== 1) return { status: 'invalid' as const };
    await tx.user.update({ where: { id: record.userId }, data: { email: targetEmail, pendingEmail: null, emailVerified: true, credentialsChangedAt: new Date() } });
    await tx.session.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    return { status: 'changed' as const, userId: record.userId, oldEmail: record.user.email, newEmail: targetEmail };
  });
  if (result.status === 'invalid') return NextResponse.json({ error: 'Confirmation link is invalid or expired.' }, { status: 401, headers: responseHeaders(req) });
  if (result.status === 'conflict') return NextResponse.json({ error: 'Email is already in use.' }, { status: 409, headers: responseHeaders(req) });
  await recordSecurityEvent(result.userId, 'email_change_completed');
  await sendEmailChangedNotice(result.oldEmail, result.newEmail).catch(() => undefined);
  return NextResponse.json({ ok: true, message: 'Email changed. Please sign in again.' }, { headers: responseHeaders(req) });
}
