import { NextResponse } from 'next/server';
import { prisma } from '../../../../lib/prisma';
import logger from '../../../../lib/logger';
import { getUserFromRequest, normalizeEmail, verifyPassword, getSensitiveActionRequirements, recordSecurityEvent } from '../../../lib/auth';
import { createEmailActionToken } from '../../../../lib/authSession';
import { sendEmailChangeConfirmation } from '../../../../services/transactionalEmailService';
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

    const { password, email } = await req.json();
    const normalizedEmail = normalizeEmail(email);
    const limit = await ensureSlidingWindow(`account-email:${user.id}`, 3, 60 * 60);
    if (!limit.ok) return authJson({ error: 'Too many email change attempts. Please try again later.' }, { status: 429 });
    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return authJson({ error: 'A valid email is required.' }, { status: 400 });
    }

    const hasPassword = typeof user.password === 'string' && user.password.trim().length > 0;
    if (hasPassword) {
      if (typeof password !== 'string' || !password.trim()) return authJson({ error: 'Password confirmation is required.' }, { status: 400 });
      const passwordMatches = await verifyPassword(password, user.password);
      if (!passwordMatches) return authJson({ error: 'Incorrect password.' }, { status: 401 });
    } else if (!['google', 'apple', 'mixed'].includes(user.authProvider)) {
      return authJson({ error: 'This account cannot confirm an email change.' }, { status: 403 });
    }

    const actionRequirements = getSensitiveActionRequirements(user);
    if (actionRequirements.requiresRecentOAuthReauth) {
      const providerName = user.oauthProvider === 'apple' ? 'Apple' : 'your sign-in provider';
      return authJson({ error: `Please confirm with ${providerName} before changing your email.` }, { status: 403 });
    }

    const existing = await prisma.user.findFirst({
      where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
    });
    if (existing && existing.id !== user.id) {
      return authJson({ error: 'Email already in use.' }, { status: 409 });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { pendingEmail: normalizedEmail },
    });
    const token = await createEmailActionToken({ userId: user.id, purpose: 'CHANGE_EMAIL', targetEmail: normalizedEmail, expiresInMinutes: 30 });
    try {
      await sendEmailChangeConfirmation(normalizedEmail, token);
    } catch (error) {
      await prisma.$transaction([
        prisma.user.updateMany({ where: { id: user.id, pendingEmail: normalizedEmail }, data: { pendingEmail: null } }),
        prisma.emailActionToken.updateMany({ where: { userId: user.id, purpose: 'CHANGE_EMAIL', usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } }),
      ]);
      throw error;
    }
    await recordSecurityEvent(user.id, 'email_change_requested');
    return authJson({ ok: true, message: 'Check the new address to confirm this change.' });
  } catch (error: unknown) {
    logger.error('Email change failed', { error });
    return authJson({ error: 'Unable to change email right now.' }, { status: 500 });
  }
}
