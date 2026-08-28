import { NextResponse } from 'next/server';
import { prisma } from '../../../../lib/prisma';
import logger from '../../../../lib/logger';
import { getUserFromRequest, normalizeEmail, hashPassword, validatePasswordStrength, verifyPassword, getSensitiveActionRequirements } from '../../../lib/auth';
import { ensureSlidingWindow } from '../../../../lib/rateLimiter';
import { sendPasswordChangedEmail } from '../../../../services/transactionalEmailService';

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const limit = await ensureSlidingWindow(`account-password:${user.id}`, 5, 15 * 60);
    if (!limit.ok) return NextResponse.json({ error: 'Too many password change attempts. Please try again later.' }, { status: 429 });

    const { currentPassword, newPassword, confirmPassword } = await req.json();
    if (typeof newPassword !== 'string' || !newPassword.trim()) {
      return NextResponse.json({ error: 'New password is required.' }, { status: 400 });
    }
    if (typeof confirmPassword !== 'string' || confirmPassword !== newPassword) {
      return NextResponse.json({ error: 'New passwords must match.' }, { status: 400 });
    }

    const alreadyHasPassword = typeof user.password === 'string' && user.password.trim().length > 0;
    if (alreadyHasPassword) {
      if (typeof currentPassword !== 'string' || !currentPassword.trim()) {
        return NextResponse.json({ error: 'Current password is required.' }, { status: 400 });
      }

      const currentPasswordMatches = await verifyPassword(currentPassword, user.password);
      if (!currentPasswordMatches) {
        return NextResponse.json({ error: 'Current password is incorrect.' }, { status: 401 });
      }
    }

    const actionRequirements = getSensitiveActionRequirements(user);
    if (actionRequirements.requiresRecentOAuthReauth) {
      const providerName = user.oauthProvider === 'apple' ? 'Apple' : 'your sign-in provider';
      return NextResponse.json({ error: `Please confirm with ${providerName} before changing your password.` }, { status: 403 });
    }

    const passwordPolicy = validatePasswordStrength(newPassword);
    if (!passwordPolicy.isValid) {
      return NextResponse.json({ error: passwordPolicy.reasons.join(' ') }, { status: 400 });
    }

    const normalizedEmail = normalizeEmail(user.email);
    const hashed = await hashPassword(newPassword);
    await prisma.$transaction(async (tx) => {
      const updateData: Record<string, unknown> = { password: hashed, email: normalizedEmail, credentialsChangedAt: new Date() };
      // If this user previously signed in with Google only and had no password,
      // adding a password should mark the account as supporting both methods.
      if ((user.authProvider === 'google' || user.authProvider === 'apple') && !alreadyHasPassword) {
        updateData.authProvider = 'mixed';
      }

      await tx.user.update({
        where: { id: user.id },
        data: updateData,
      });
      await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    // notify user about password change (best-effort)
    try {
      const { createNotification } = await import('../../../services/notificationService');
      await createNotification(user.id, {
        title: 'Password changed',
        body: 'Your account password was recently changed. If this wasn\'t you, please contact support.',
        type: 'security',
      });
    } catch {
      // ignore
    }

    await sendPasswordChangedEmail(user.email).catch((error) => {
      logger.warn('Password change security notice could not be sent', { error });
    });

    return NextResponse.json({ success: true, passwordSetup: !alreadyHasPassword });
  } catch (error: unknown) {
    logger.error('Password change failed', { error });
    return NextResponse.json({ error: 'Unable to change password right now.' }, { status: 500 });
  }
}
