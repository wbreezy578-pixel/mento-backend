import { NextResponse } from 'next/server';
import { consumeEmailActionToken } from '../../../../lib/authSession';
import { prisma } from '../../../../lib/prisma';
import { normalizeEmail, recordSecurityEvent } from '../../../lib/auth';

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const record = token ? await consumeEmailActionToken(token, 'CHANGE_EMAIL') : null;
  const targetEmail = normalizeEmail(record?.targetEmail);
  if (!record || !targetEmail || record.user.pendingEmail !== targetEmail) return NextResponse.json({ error: 'Confirmation link is invalid or expired.' }, { status: 401 });
  const existing = await prisma.user.findFirst({ where: { email: { equals: targetEmail, mode: 'insensitive' }, id: { not: record.userId } } });
  if (existing) return NextResponse.json({ error: 'Email is already in use.' }, { status: 409 });
  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { email: targetEmail, pendingEmail: null, emailVerified: true, credentialsChangedAt: new Date() } }),
    prisma.session.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  await recordSecurityEvent(record.userId, 'email_change_completed');
  return NextResponse.json({ ok: true, message: 'Email changed. Please sign in again.' });
}
