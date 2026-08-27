import { NextResponse } from 'next/server';
import logger from '../../../lib/logger';
import { normalizeEmail, validatePasswordStrength, recordSecurityEvent } from '../../lib/auth';
import { createEmailActionToken } from '../../../lib/authSession';
import { createNotification } from '../../services/notificationService';
import { createEmailAccount, InvalidAccountInputError } from '../../../services/userAccountService';
import { CURRENT_LEGAL_VERSIONS } from '../../../lib/legalVersions';
import { prisma } from '../../../lib/prisma';
import { randomUUID } from 'crypto';
import { validateLegalAcceptance } from '../../../lib/legalConsent';
import { sendVerificationEmail } from '../../../services/transactionalEmailService';
import { ensureSlidingWindow } from '../../../lib/rateLimiter';
import { authRateLimitSubject, getClientIp } from '../../lib/auth';

export async function POST(req: Request) {
  try {
    const { email, password, confirmPassword, name, ageConfirmed, legalVersions } = await req.json();
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || typeof password !== 'string' || !password.trim()) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
    }
    if (typeof confirmPassword !== 'string' || confirmPassword !== password) {
      return NextResponse.json({ error: 'Password confirmation must match.' }, { status: 400 });
    }
    const clientIp = getClientIp(req);
    const [ipLimit, emailLimit] = await Promise.all([
      ensureSlidingWindow(`signup:ip:${clientIp}`, 10, 60 * 60),
      ensureSlidingWindow(`signup:email:${authRateLimitSubject(normalizedEmail)}`, 3, 60 * 60),
    ]);
    if (!ipLimit.ok || !emailLimit.ok) return NextResponse.json({ error: 'Too many signup attempts. Please try again later.' }, { status: 429 });
    const legalError = validateLegalAcceptance({ ageConfirmed, legalVersions });
    if (legalError) return NextResponse.json({ error: legalError }, { status: legalError.includes('18') ? 400 : 409 });

    const passwordPolicy = validatePasswordStrength(password);
    if (!passwordPolicy.isValid) {
      return NextResponse.json({ error: passwordPolicy.reasons.join(' ') }, { status: 400 });
    }

    let accountResult;
    try {
      accountResult = await createEmailAccount({
        email: normalizedEmail,
        password,
        name,
      });
    } catch (error) {
      if (error instanceof InvalidAccountInputError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }

    if (!accountResult.created) {
      if (!accountResult.user.emailVerified && accountResult.user.authProvider === 'email') {
        const token = await createEmailActionToken({ userId: accountResult.user.id, purpose: 'VERIFY_EMAIL', expiresInMinutes: 60 });
        await sendVerificationEmail(accountResult.user.email, token);
      }
      return NextResponse.json({ ok: true, requiresEmailVerification: true, message: 'If this address can be registered, check your email for the next step.' }, { status: 202 });
    }

    const user = accountResult.user;
    await prisma.$executeRaw`
      INSERT INTO "ConsentRecord" ("id", "userId", "privacyVersion", "termsVersion", "aiNoticeVersion", "source", "acceptedAt", "revokedAt")
      VALUES (${randomUUID()}, ${user.id}, ${CURRENT_LEGAL_VERSIONS.privacy}, ${CURRENT_LEGAL_VERSIONS.terms}, ${CURRENT_LEGAL_VERSIONS.aiNotice}, 'android-signup', ${new Date()}, NULL)
      ON CONFLICT ("userId", "privacyVersion", "termsVersion", "aiNoticeVersion") DO NOTHING
    `;
    const verificationToken = await createEmailActionToken({ userId: user.id, purpose: 'VERIFY_EMAIL', expiresInMinutes: 60 });
    await sendVerificationEmail(user.email, verificationToken);
    await recordSecurityEvent(user.id, 'signup_verification_sent');

    // best-effort welcome notification
    try {
      await createNotification(user.id, {
        title: 'Welcome to Mento',
        body: `Thanks for signing up${user.name ? `, ${user.name}` : ''}!`,
        type: 'welcome',
      });
    } catch {
      // ignore notification errors
    }

    return NextResponse.json({ ok: true, requiresEmailVerification: true, message: 'Check your email to verify your Mento account.' }, { status: 201 });
  } catch (err: unknown) {
    logger.error('Signup error', { error: err });
    return NextResponse.json({ error: 'Unable to create account right now.' }, { status: 500 });
  }
}
