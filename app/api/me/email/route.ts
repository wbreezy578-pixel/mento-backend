import { NextResponse } from 'next/server';
import { prisma } from '../../../../lib/prisma';
import logger from '../../../../lib/logger';
import { getUserFromRequest, normalizeEmail, verifyPassword, getSensitiveActionRequirements, recordSecurityEvent } from '../../../lib/auth';
import { createEmailActionToken } from '../../../../lib/authSession';
import { sendEmailChangeConfirmation } from '../../../../services/transactionalEmailService';

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { password, email } = await req.json();
    const normalizedEmail = normalizeEmail(email);
    if (typeof password !== 'string' || !password.trim()) {
      return NextResponse.json({ error: 'Password confirmation is required.' }, { status: 400 });
    }
    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 });
    }

    const passwordMatches = await verifyPassword(password, user.password);
    if (!passwordMatches) {
      return NextResponse.json({ error: 'Incorrect password.' }, { status: 401 });
    }

    const actionRequirements = getSensitiveActionRequirements(user);
    if (actionRequirements.requiresRecentOAuthReauth) {
      return NextResponse.json({ error: 'Please re-authenticate with Google recently before changing your email.' }, { status: 403 });
    }

    const existing = await prisma.user.findFirst({
      where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
    });
    if (existing && existing.id !== user.id) {
      return NextResponse.json({ error: 'Email already in use.' }, { status: 409 });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { pendingEmail: normalizedEmail },
    });
    const token = await createEmailActionToken({ userId: user.id, purpose: 'CHANGE_EMAIL', targetEmail: normalizedEmail, expiresInMinutes: 30 });
    await sendEmailChangeConfirmation(normalizedEmail, token);
    await recordSecurityEvent(user.id, 'email_change_requested');
    return NextResponse.json({ ok: true, message: 'Check the new address to confirm this change.' });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Email change failed.';
    logger.error('Email change failed', { error });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
