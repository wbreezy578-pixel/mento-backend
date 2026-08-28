import { NextResponse } from 'next/server';
import { prisma } from '../../../lib/prisma';
import logger from '../../../lib/logger';
import { signToken, normalizeEmail, verifyPassword, buildUserSummary, getLoginPolicyState, incrementFailedLoginAttempts, resetFailedLoginAttempts, recordSecurityEvent, applyAuthCookies, getClientIp, getSessionClientIp, authRateLimitSubject } from '../../lib/auth';
import { createNotification } from '../../services/notificationService';
import { createSessionRecord, generateSecureToken, getRefreshSessionExpiry, REFRESH_SESSION_ABSOLUTE_TTL_MS } from '../../../lib/authSession';
import { buildCorsHeaders } from '../../../lib/securityHeaders';
import { ensureSlidingWindow } from '../../../lib/rateLimiter';

const CORS_METHODS = 'POST, OPTIONS';
const LOGIN_FAILURE_MESSAGE = 'Unable to sign in. Check your credentials and email verification status.';

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
      ensureSlidingWindow(`login:account:${authRateLimitSubject(normalizedEmail)}`, 10, 15 * 60),
    ]);
    if (!ipLimit.ok || !accountLimit.ok) return NextResponse.json({ error: 'Too many sign-in attempts. Please try again later.' }, { status: 429 });

    const user = await prisma.user.findFirst({
      where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
    });
    if (!user) {
      await verifyPassword(String(password), '$2b$12$C6UzMDM.H6dfI/f/IKcEe.8jO4KQWv6q6Qp2kCB2Q9d8qQ0N9cF8K');
      await recordSecurityEvent(null, 'login_failed', { accountSubject: authRateLimitSubject(normalizedEmail), reason: 'user_not_found' });
      return NextResponse.json({ error: LOGIN_FAILURE_MESSAGE }, { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    if (!user.emailVerified || user.accountStatus !== 'ACTIVE') {
      return NextResponse.json({ error: LOGIN_FAILURE_MESSAGE }, { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const loginPolicy = getLoginPolicyState(user);
    if (!loginPolicy.allowed) {
      await verifyPassword(String(password), user.password);
      await recordSecurityEvent(user.id, 'login_blocked', { reason: loginPolicy.reason });
      return NextResponse.json({ error: LOGIN_FAILURE_MESSAGE }, { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const passwordFieldExists = typeof user.password === 'string' && user.password.trim().length > 0;

    if (!passwordFieldExists) {
      return NextResponse.json(
        { error: LOGIN_FAILURE_MESSAGE },
        { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } }
      );
    }

    const match = await verifyPassword(password, user.password);
    if (!match) {
      await incrementFailedLoginAttempts(user.id);
      const clientIp = getClientIp(req);
      await recordSecurityEvent(user.id, 'login_failed', { reason: 'invalid_password', networkSubject: authRateLimitSubject(clientIp) });
      return NextResponse.json({ error: LOGIN_FAILURE_MESSAGE }, { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    await resetFailedLoginAttempts(user.id);
    const refreshTokenValue = generateSecureToken();
    const absoluteExpiresAt = new Date(Date.now() + REFRESH_SESSION_ABSOLUTE_TTL_MS);
    const sessionExpiresAt = getRefreshSessionExpiry(absoluteExpiresAt);
    const session = await createSessionRecord({
      userId: user.id,
      token: refreshTokenValue,
      userAgent: req.headers.get('user-agent') ?? null,
      ipAddress: getSessionClientIp(req),
      expiresAt: sessionExpiresAt,
      absoluteExpiresAt,
    });
    const accessToken = signToken(user.id, normalizedEmail, { sessionId: session.id, expiresInSeconds: 15 * 60 });
    await recordSecurityEvent(user.id, 'login_success', { networkSubject: authRateLimitSubject(clientIp) });

    // best-effort security notification on successful login
    try {
      await createNotification(user.id, {
        title: 'New sign-in detected',
        body: `We detected a new sign-in to your account. If this wasn't you, change your password.`,
        type: 'security',
      });
    } catch {
      // ignore
    }

    const response = NextResponse.json({
      token: accessToken,
      refreshToken: refreshTokenValue,
      sessionExpiresAt: sessionExpiresAt.toISOString(),
      user: buildUserSummary(user),
    }, { headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    applyAuthCookies(response, {
      accessToken,
      refreshToken: refreshTokenValue,
      isProduction: process.env.NODE_ENV === 'production',
    });
    return response;
  } catch (err: unknown) {
    logger.error('Login error', { error: err });
    return NextResponse.json({ error: 'Unable to sign in right now.' }, { status: 500, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
  }
}
