import { NextResponse } from 'next/server';
import logger from '../../../lib/logger';
import { signToken, normalizeEmail, validatePasswordStrength, buildUserSummary, recordSecurityEvent, applyAuthCookies } from '../../lib/auth';
import { createSessionRecord, generateSecureToken } from '../../../lib/authSession';
import { createNotification } from '../../services/notificationService';
import { createEmailAccount, InvalidAccountInputError } from '../../../services/userAccountService';
import { CURRENT_LEGAL_VERSIONS } from '../../../lib/legalVersions';
import { prisma } from '../../../lib/prisma';
import { randomUUID } from 'crypto';
import { validateLegalAcceptance } from '../../../lib/legalConsent';

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

    if (!accountResult.created && accountResult.requiresPasswordSetup) {
      return NextResponse.json({
        error: 'An account already exists for this email. Please sign in with Google or use the password setup flow to add an email/password login to your existing account.',
        requiresPasswordSetup: true,
        existingUserId: accountResult.existingUserId,
      }, { status: 409 });
    }

    if (!accountResult.created) {
      return NextResponse.json({
        error: 'An account already exists for this email. Please sign in with your existing credentials.',
        existingUserId: accountResult.existingUserId,
      }, { status: 409 });
    }

    const user = accountResult.user;
    await prisma.$executeRaw`
      INSERT INTO "ConsentRecord" ("id", "userId", "privacyVersion", "termsVersion", "aiNoticeVersion", "source", "acceptedAt", "revokedAt")
      VALUES (${randomUUID()}, ${user.id}, ${CURRENT_LEGAL_VERSIONS.privacy}, ${CURRENT_LEGAL_VERSIONS.terms}, ${CURRENT_LEGAL_VERSIONS.aiNotice}, 'android-signup', ${new Date()}, NULL)
      ON CONFLICT ("userId", "privacyVersion", "termsVersion", "aiNoticeVersion") DO NOTHING
    `;
    const accessToken = signToken(user.id, normalizedEmail, { expiresInSeconds: 15 * 60 });
    const refreshTokenValue = generateSecureToken();
    const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await createSessionRecord({
      userId: user.id,
      token: refreshTokenValue,
      userAgent: req.headers.get('user-agent') ?? null,
      ipAddress: req.headers.get('x-forwarded-for') ?? null,
      expiresAt: sessionExpiresAt,
    });
    await recordSecurityEvent(user.id, 'signup_completed', { email: normalizedEmail });

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

    const response = NextResponse.json({
      token: accessToken,
      refreshToken: refreshTokenValue,
      sessionExpiresAt: sessionExpiresAt.toISOString(),
      user: buildUserSummary(user),
    }, { status: 201 });
    applyAuthCookies(response, {
      accessToken,
      refreshToken: refreshTokenValue,
      isProduction: process.env.NODE_ENV === 'production',
    });
    return response;
  } catch (err: unknown) {
    logger.error('Signup error', { error: err });
    const message = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
