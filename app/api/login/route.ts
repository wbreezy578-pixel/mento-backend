import { NextResponse } from 'next/server';
import { prisma } from '../../../lib/prisma';
import logger from '../../../lib/logger';
import { signToken, normalizeEmail, verifyPassword, buildUserSummary, incrementFailedLoginAttempts, resetFailedLoginAttempts, recordSecurityEvent, applyAuthCookies, getClientIp, authRateLimitSubject } from '../../lib/auth';
import { createNotification } from '../../services/notificationService';
import { createSessionRecord, generateSecureToken } from '../../../lib/authSession';
import { buildCorsHeaders } from '../../../lib/securityHeaders';
import { ensureSlidingWindow } from '../../../lib/rateLimiter';

const CORS_METHODS = 'POST, OPTIONS';
const LOGIN_FAILURE_MESSAGE = 'Unable to sign in. Check your credentials and email verification status.';

export async function OPTIONS(req: Request) {
  logger.info('Login OPTIONS preflight', {
    origin: req.headers.get('origin'),
  });
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
  logger.info('Login POST received', {
    origin: req.headers.get('origin'),
  });

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
      logger.info('Login lookup result', { found: false });
      await recordSecurityEvent(null, 'login_failed', { email: normalizedEmail, reason: 'user_not_found' });
      return NextResponse.json({ error: LOGIN_FAILURE_MESSAGE }, { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    if (!user.emailVerified || user.accountStatus !== 'ACTIVE') {
      return NextResponse.json({ error: LOGIN_FAILURE_MESSAGE }, { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    logger.info('Login lookup result', { found: true, userId: user.id });
    const passwordFieldExists = typeof user.password === 'string' && user.password.trim().length > 0;
    logger.info('Login password field status', { userId: user.id, passwordFieldExists });

    if (!passwordFieldExists) {
      return NextResponse.json(
        { error: LOGIN_FAILURE_MESSAGE },
        { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } }
      );
    }

    const match = await verifyPassword(password, user.password);
    logger.info('Login password compare result', { userId: user.id, match });
    if (!match) {
      await incrementFailedLoginAttempts(user.id);
      const clientIp = getClientIp(req);
      await recordSecurityEvent(user.id, 'login_failed', { email: normalizedEmail, reason: 'invalid_password', ipAddress: clientIp });
      return NextResponse.json({ error: LOGIN_FAILURE_MESSAGE }, { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    await resetFailedLoginAttempts(user.id);
    const refreshTokenValue = generateSecureToken();
    const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const session = await createSessionRecord({
      userId: user.id,
      token: refreshTokenValue,
      userAgent: req.headers.get('user-agent') ?? null,
      ipAddress: req.headers.get('x-forwarded-for') ?? null,
      expiresAt: sessionExpiresAt,
    });
    const accessToken = signToken(user.id, normalizedEmail, { sessionId: session.id, expiresInSeconds: 15 * 60 });
    await recordSecurityEvent(user.id, 'login_success', { email: normalizedEmail, ipAddress: clientIp });

    // best-effort security notification on successful login
    try {
      await createNotification(user.id, {
        title: 'New sign-in detected',
        body: `We detected a new sign-in to your account. If this wasn't you, change your password.`,
        type: 'security',
      });
    } catch (e) {
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
    const message = err instanceof Error ? err.message : 'Internal error';
    logger.error('Login error', { error: err });
    return NextResponse.json({ error: message }, { status: 500, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
  }
}
