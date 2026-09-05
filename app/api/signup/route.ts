import { NextResponse } from 'next/server';
import logger from '../../../lib/logger';
import { normalizeEmail, validatePasswordStrength, recordSecurityEvent } from '../../lib/auth';
import { createEmailActionToken } from '../../../lib/authSession';
import { createNotification } from '../../services/notificationService';
import { createEmailAccount, InvalidAccountInputError } from '../../../services/userAccountService';
import { CURRENT_LEGAL_VERSIONS } from '../../../lib/legalVersions';
import { validateLegalAcceptance } from '../../../lib/legalConsent';
import { sendVerificationEmail } from '../../../services/transactionalEmailService';
import { ensureSlidingWindow } from '../../../lib/rateLimiter';
import { authRateLimitSubject, getClientIp } from '../../lib/auth';
import { buildCorsHeaders } from '../../../lib/securityHeaders';

const CORS_METHODS = 'POST, OPTIONS';
const responseHeaders = (req: Request) => ({ ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS });

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: responseHeaders(req) });
}

export async function POST(req: Request) {
  try {
    const { email, password, confirmPassword, name, ageConfirmed, legalVersions } = await req.json();
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || typeof password !== 'string' || !password.trim()) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400, headers: responseHeaders(req) });
    }
    if (typeof confirmPassword !== 'string' || confirmPassword !== password) {
      return NextResponse.json({ error: 'Password confirmation must match.' }, { status: 400, headers: responseHeaders(req) });
    }
    const clientIp = getClientIp(req);
    const [ipLimit, emailLimit] = await Promise.all([
      ensureSlidingWindow(`signup:ip:${clientIp}`, 10, 60 * 60),
      ensureSlidingWindow(`signup:email:${authRateLimitSubject(normalizedEmail)}`, 3, 60 * 60),
    ]);
    if (!ipLimit.ok || !emailLimit.ok) return NextResponse.json({ error: 'Too many signup attempts. Please try again later.' }, { status: 429, headers: responseHeaders(req) });
    const legalError = validateLegalAcceptance({ ageConfirmed, legalVersions });
    if (legalError) return NextResponse.json({ error: legalError }, { status: legalError.includes('18') ? 400 : 409, headers: responseHeaders(req) });

    const passwordPolicy = validatePasswordStrength(password);
    if (!passwordPolicy.isValid) {
      return NextResponse.json({ error: passwordPolicy.reasons.join(' ') }, { status: 400, headers: responseHeaders(req) });
    }

    let accountResult;
    try {
      accountResult = await createEmailAccount({
        email: normalizedEmail,
        password,
        name,
        legalConsent: {
          privacyVersion: CURRENT_LEGAL_VERSIONS.privacy,
          termsVersion: CURRENT_LEGAL_VERSIONS.terms,
          aiNoticeVersion: CURRENT_LEGAL_VERSIONS.aiNotice,
          source: 'android-signup',
        },
      });
    } catch (error) {
      if (error instanceof InvalidAccountInputError) {
        return NextResponse.json({ error: error.message }, { status: 400, headers: responseHeaders(req) });
      }
      throw error;
    }

    if (!accountResult.created) {
      if (!accountResult.user.emailVerified && accountResult.user.authProvider === 'email') {
        const token = await createEmailActionToken({ userId: accountResult.user.id, purpose: 'VERIFY_EMAIL', expiresInMinutes: 60 });
        await sendVerificationEmail(accountResult.user.email, token);
      }
      return NextResponse.json({ ok: true, requiresEmailVerification: true, message: 'If this address can be registered, check your email for the next step.' }, { status: 202, headers: responseHeaders(req) });
    }

    const user = accountResult.user;
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

    return NextResponse.json({ ok: true, requiresEmailVerification: true, message: 'Check your email to verify your Mento account.' }, { status: 201, headers: responseHeaders(req) });
  } catch (err: unknown) {
    logger.error('Signup failed', { errorName: err instanceof Error ? err.name : 'unknown' });
    return NextResponse.json({ error: 'Unable to create account right now.' }, { status: 500, headers: responseHeaders(req) });
  }
}
