import { NextResponse } from 'next/server';
import { consumeEmailActionToken } from '../../../../lib/authSession';
import { prisma } from '../../../../lib/prisma';
import { recordSecurityEvent } from '../../../lib/auth';

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token) return NextResponse.json({ error: 'Verification link is invalid.' }, { status: 400 });
  const record = await consumeEmailActionToken(token, 'VERIFY_EMAIL');
  if (!record) return NextResponse.json({ error: 'Verification link is invalid or expired.' }, { status: 401 });
  await prisma.user.update({ where: { id: record.userId }, data: { emailVerified: true, accountStatus: 'ACTIVE', credentialsChangedAt: new Date() } });
  await recordSecurityEvent(record.userId, 'email_verified');
  return NextResponse.json({ ok: true, message: 'Email verified. You can now sign in.' });
}
