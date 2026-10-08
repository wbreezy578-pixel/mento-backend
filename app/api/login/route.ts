import { NextResponse } from 'next/server';
import { prisma } from '../../../lib/prisma';
import logger from '../../../lib/logger';
import { normalizeEmail, verifyPassword, getLoginPolicyState, incrementFailedLoginAttempts, recordSecurityEvent, getClientIp, authRateLimitSubject, DUMMY_BCRYPT_HASH } from '../../lib/auth';
import { createLoginMfaChallenge, hashClientDeviceId } from '../../../lib/authSession';
import { buildCorsHeaders } from '../../../lib/securityHeaders';
import { ensureSlidingWindow } from '../../../lib/rateLimiter';
import { sendLoginMfaCode } from '../../../services/transactionalEmailService';
import { isGooglePlayReviewAccount } from '../../../lib/googlePlayReviewAccess';
import { createNotification } from '../../services/notificationService';
import { createSessionRecord, generateSecureToken, getRefreshSessionExpiry, REFRESH_SESSION_ABSOLUTE_TTL_MS } from '../../../lib/authSession';
import { applyAuthCookies, buildAuthSessionResponseBody, buildUserSummary, getSessionClientIp, isBrowserAuthRequest, resetFailedLoginAttempts, signToken } from '../../lib/auth';
import type { RateLimitDecision } from '../../../lib/rateLimiter';

const CORS_METHODS = 'POST, OPTIONS';
const LOGIN_FAILURE_MESSAGE = 'Unable to sign in. Check your email and password.';

function loginErrorMetadata(error: unknown) {
  if (!error || typeof error !== 'object') return {};
  const candidate = error as { code?: unknown };
  return typeof candidate.code === 'string' ? { code: candidate.code } : {};
}

export async function OPTIONS(req: Request) {
  const corsHeaders = buildCorsHeaders(req.headers.get('origin'));
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...corsHeaders,
      'Access-Control-Allow-Methods': CORS_METHODS,
    },
  });
}

export async function POST(req: Request) {
  try {
    const { email, password } = await req.json();
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || !password) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }
    const clientIp = getClientIp(req);
    const [ipLimit, accountLimit] = await Promise.all([
      ensureSlidingWindow(`login:ip:${clientIp}`, 30, 15 * 60),
      isGooglePlayReviewAccount(normalizedEmail)
        ? Promise.resolve<RateLimitDecision>({ ok: true })
        : ensureSlidingWindow(`login:account:${authRateLimitSubject(normalizedEmail)}`, 10, 15 * 60),
    ]);
    if (!ipLimit.ok || !accountLimit.ok) {
      const unavailable = ipLimit.unavailable || accountLimit.unavailable;
      const retryAfterSec = Math.max(ipLimit.retryAfterSec ?? 0, accountLimit.retryAfterSec ?? 0, 5);
      return NextResponse.json(
        { error: unavailable ? 'Sign-in is temporarily unavailable. Please try again shortly.' : 'Too many sign-in attempts. Please try again later.' },
        {
          status: unavailable ? 503 : 429,
          headers: {
            ...buildCorsHeaders(req.headers.get('origin')),
            'Access-Control-Allow-Methods': CORS_METHODS,
            'Retry-After': String(retryAfterSec),
          },
        },
      );
    }

    const user = await prisma.user.findFirst({
      where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
    });
    if (!user) {
      await verifyPassword(String(password), DUMMY_BCRYPT_HASH);
      await recordSecurityEvent(null, 'login_failed', { accountSubject: authRateLimitSubject(normalizedEmail), reason: 'user_not_found' });
      return NextResponse.json({ error: LOGIN_FAILURE_MESSAGE }, { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const passwordFieldExists = typeof user.password === 'string' && user.password.trim().length > 0;

    if (!passwordFieldExists) {
      await verifyPassword(String(password), DUMMY_BCRYPT_HASH);
      return NextResponse.json(
        { error: LOGIN_FAILURE_MESSAGE },
        { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } }
      );
    }

    if (!user.emailVerified) {
      const passwordMatches = await verifyPassword(String(password), user.password);
      if (passwordMatches && user.accountStatus === 'UNVERIFIED') {
        await recordSecurityEvent(user.id, 'login_blocked', { reason: 'email_not_verified' });
        return NextResponse.json(
          { error: 'Verify your email before signing in.', code: 'email_not_verified' },
          { status: 403, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } }
        );
      }
      return NextResponse.json({ error: LOGIN_FAILURE_MESSAGE }, { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    if (user.accountStatus !== 'ACTIVE') {
      await verifyPassword(String(password), user.password);
      return NextResponse.json({ error: LOGIN_FAILURE_MESSAGE }, { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const loginPolicy = getLoginPolicyState(user);
    if (!loginPolicy.allowed) {
      const passwordMatches = await verifyPassword(String(password), user.password);
      await recordSecurityEvent(user.id, 'login_blocked', { reason: loginPolicy.reason });
      if (passwordMatches) {
        const retryAfterSeconds = Math.max(1, loginPolicy.lockoutRemainingSeconds);
        return NextResponse.json(
          {
            error: `This account is temporarily locked. Try again in ${Math.ceil(retryAfterSeconds / 60)} minute${retryAfterSeconds > 60 ? 's' : ''}.`,
            code: 'account_locked',
            retryAfterSeconds,
          },
          {
            status: 423,
            headers: {
              ...buildCorsHeaders(req.headers.get('origin')),
              'Access-Control-Allow-Methods': CORS_METHODS,
              'Retry-After': String(retryAfterSeconds),
            },
          }
        );
      }
      return NextResponse.json({ error: LOGIN_FAILURE_MESSAGE }, { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const match = await verifyPassword(password, user.password);
    if (!match) {
      await incrementFailedLoginAttempts(user.id);
      const clientIp = getClientIp(req);
      await recordSecurityEvent(user.id, 'login_failed', { reason: 'invalid_password', networkSubject: authRateLimitSubject(clientIp) });
      return NextResponse.json({ error: LOGIN_FAILURE_MESSAGE }, { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    if (isGooglePlayReviewAccount(user.email)) {
      await resetFailedLoginAttempts(user.id);
      const refreshTokenValue = generateSecureToken();
      const absoluteExpiresAt = new Date(Date.now() + REFRESH_SESSION_ABSOLUTE_TTL_MS);
      const sessionExpiresAt = getRefreshSessionExpiry(absoluteExpiresAt);
      const session = await createSessionRecord({
        userId: user.id,
        token: refreshTokenValue,
        userAgent: req.headers.get('user-agent') ?? null,
        ipAddress: getSessionClientIp(req),
        deviceIdHash: hashClientDeviceId(req.headers.get('x-mento-device-id')),
        expiresAt: sessionExpiresAt,
        absoluteExpiresAt,
      });
      const accessToken = signToken(user.id, user.email, { sessionId: session.id, expiresInSeconds: 15 * 60 });
      await recordSecurityEvent(user.id, 'login_success', { networkSubject: authRateLimitSubject(getSessionClientIp(req) ?? 'unknown'), mfa: 'review_account_bypass' });
      try {
        await createNotification(user.id, { title: 'New sign-in detected', body: `We detected a new sign-in to your account. If this wasn't you, change your password.`, type: 'security' });
      } catch {
        // Security notification failure must not invalidate a successful login.
      }
      const browserSession = isBrowserAuthRequest(req);
      const response = NextResponse.json(buildAuthSessionResponseBody({ browserSession, accessToken, refreshToken: refreshTokenValue, sessionExpiresAt: sessionExpiresAt.toISOString(), user: buildUserSummary(user) }), { headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
      applyAuthCookies(response, { accessToken, refreshToken: refreshTokenValue, isProduction: process.env.NODE_ENV === 'production', browserSession });
      return response;
    }

    const { challengeToken, code } = await createLoginMfaChallenge(user.id, {
      deviceIdHash: hashClientDeviceId(req.headers.get('x-mento-device-id')),
    });
    await sendLoginMfaCode(user.email, code);
    return NextResponse.json(
      { requiresMfa: true, challengeToken, message: 'Enter the sign-in code sent to your email.' },
      { status: 202, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS, 'Cache-Control': 'no-store' } },
    );
  } catch (err: unknown) {
    logger.error('Login failed', {
      errorName: err instanceof Error ? err.name : 'unknown',
      ...loginErrorMetadata(err),
    });
    return NextResponse.json({ error: 'Unable to sign in right now.' }, { status: 500, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
  }
}
