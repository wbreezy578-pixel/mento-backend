import { NextResponse } from 'next/server';
import { createNotification } from '../../../services/notificationService';
import { consumeLoginMfaChallenge, createSessionRecord, generateSecureToken, getRefreshSessionExpiry, hashClientDeviceId, LoginMfaChallengeContextMismatchError, REFRESH_SESSION_ABSOLUTE_TTL_MS } from '../../../../lib/authSession';
import { buildUserSummary, applyAuthCookies, buildAuthSessionResponseBody, isBrowserAuthRequest, getSessionClientIp, authRateLimitSubject, resetFailedLoginAttempts, recordSecurityEvent } from '../../../lib/auth';
import { buildCorsHeaders } from '../../../../lib/securityHeaders';
import { ensureSlidingWindow } from '../../../../lib/rateLimiter';

const CORS_METHODS = 'POST, OPTIONS';
const headersFor = (req: Request) => ({ ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS });

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: headersFor(req) });
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null) as { challengeToken?: unknown; code?: unknown } | null;
    const challengeToken = typeof body?.challengeToken === 'string' ? body.challengeToken.trim() : '';
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!/^[a-f0-9]{64}$/.test(challengeToken) || !/^\d{6}$/.test(code)) {
      return NextResponse.json({ error: 'A valid sign-in code is required.' }, { status: 400, headers: headersFor(req) });
    }

    const rateLimit = await ensureSlidingWindow(`login:mfa:${authRateLimitSubject(challengeToken)}`, 5, 10 * 60);
    if (!rateLimit.ok) {
      const unavailable = rateLimit.unavailable === true;
      return NextResponse.json(
        { error: unavailable ? 'Sign-in is temporarily unavailable. Please try again shortly.' : 'Too many code attempts. Request a new sign-in code later.' },
        {
          status: unavailable ? 503 : 429,
          headers: { ...headersFor(req), 'Retry-After': String(rateLimit.retryAfterSec ?? (unavailable ? 5 : 60)) },
        },
      );
    }

    let challenge;
    try {
      challenge = await consumeLoginMfaChallenge(challengeToken, code, hashClientDeviceId(req.headers.get('x-mento-device-id')));
    } catch (error) {
      if (error instanceof LoginMfaChallengeContextMismatchError) {
        await recordSecurityEvent(error.userId, 'mfa_challenge_device_mismatch', { deviceIdProvided: Boolean(hashClientDeviceId(req.headers.get('x-mento-device-id'))) });
        try {
          await createNotification(error.userId, {
            title: 'Sign-in security alert',
            body: 'A sign-in code was presented from an unrecognized device. If this was not you, change your password.',
            type: 'security',
            category: 'SECURITY',
          });
        } catch {
          // Notifications must not reveal whether the challenge was valid.
        }
        return NextResponse.json({ error: 'That sign-in code is invalid or expired.' }, { status: 401, headers: headersFor(req) });
      }
      throw error;
    }
    if (!challenge || challenge.user.accountStatus !== 'ACTIVE' || !challenge.user.emailVerified) {
      return NextResponse.json({ error: 'That sign-in code is invalid or expired.' }, { status: 401, headers: headersFor(req) });
    }

    await resetFailedLoginAttempts(challenge.user.id);
    const refreshTokenValue = generateSecureToken();
    const absoluteExpiresAt = new Date(Date.now() + REFRESH_SESSION_ABSOLUTE_TTL_MS);
    const sessionExpiresAt = getRefreshSessionExpiry(absoluteExpiresAt);
    const session = await createSessionRecord({
      userId: challenge.user.id,
      token: refreshTokenValue,
      userAgent: req.headers.get('user-agent') ?? null,
      ipAddress: getSessionClientIp(req),
      deviceIdHash: hashClientDeviceId(req.headers.get('x-mento-device-id')),
      expiresAt: sessionExpiresAt,
      absoluteExpiresAt,
    });
    const accessToken = (await import('../../../lib/auth')).signToken(challenge.user.id, challenge.user.email, { sessionId: session.id, expiresInSeconds: 15 * 60 });
    const clientIp = getSessionClientIp(req) ?? 'unknown';
    await recordSecurityEvent(challenge.user.id, 'login_success', { networkSubject: authRateLimitSubject(clientIp), mfa: 'email' });
    try {
      await createNotification(challenge.user.id, { title: 'New sign-in detected', body: `We detected a new sign-in to your account. If this wasn't you, change your password.`, type: 'security' });
    } catch {
      // Security notification failure must not invalidate a successful login.
    }

    const browserSession = isBrowserAuthRequest(req);
    const response = NextResponse.json(buildAuthSessionResponseBody({ browserSession, accessToken, refreshToken: refreshTokenValue, sessionExpiresAt: sessionExpiresAt.toISOString(), user: buildUserSummary(challenge.user) }), { headers: headersFor(req) });
    applyAuthCookies(response, { accessToken, refreshToken: refreshTokenValue, isProduction: process.env.NODE_ENV === 'production', browserSession });
    return response;
  } catch {
    return NextResponse.json({ error: 'Unable to verify the sign-in code right now.' }, { status: 500, headers: headersFor(req) });
  }
}
