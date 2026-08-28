import { NextResponse } from 'next/server';
import { signToken, normalizeEmail, recordSecurityEvent, buildUserSummary, applyAuthCookies, getClientIp } from '../../../lib/auth';
import { findSessionByToken, generateSecureToken, RefreshSessionAlreadyUsedError, revokeSessionFamily, rotateRefreshSession } from '../../../../lib/authSession';
import { buildCorsHeaders } from '../../../../lib/securityHeaders';
import { ensureSlidingWindow } from '../../../../lib/rateLimiter';

const CORS_METHODS = 'POST, OPTIONS';

export async function OPTIONS(req: Request) {
  const corsHeaders = buildCorsHeaders(req.headers.get('origin'));
  return new NextResponse(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Allow-Methods': CORS_METHODS } });
}

export async function POST(req: Request) {
  try {
    const limit = await ensureSlidingWindow(`refresh:ip:${getClientIp(req)}`, 60, 15 * 60);
    if (!limit.ok) return NextResponse.json({ error: 'Too many refresh attempts. Please try again later.' }, { status: 429, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    const body = await req.json();
    const refreshToken = typeof body?.refreshToken === 'string' ? body.refreshToken.trim() : '';
    if (!refreshToken) {
      return NextResponse.json({ error: 'Refresh token required' }, { status: 400, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const sessionRecord = await findSessionByToken(refreshToken);

    if (!sessionRecord) {
      return NextResponse.json({ error: 'Refresh token expired' }, { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    if (sessionRecord.revokedAt || sessionRecord.replacedBySessionId) {
      await revokeSessionFamily(sessionRecord.familyId);
      await recordSecurityEvent(sessionRecord.userId, 'refresh_token_reuse_detected', { familyId: sessionRecord.familyId });
      return NextResponse.json({ error: 'Session security check failed. Please sign in again.' }, { status: 401 });
    }

    if (sessionRecord.expiresAt.getTime() <= Date.now() || sessionRecord.absoluteExpiresAt.getTime() <= Date.now()) {
      return NextResponse.json({ error: 'Refresh token expired' }, { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const user = sessionRecord.user;
    if (!user.emailVerified || user.accountStatus !== 'ACTIVE') return NextResponse.json({ error: 'Account is not active.' }, { status: 403 });
    const rotatedRefreshToken = generateSecureToken();
    const rollingExpiry = new Date(Math.min(Date.now() + 30 * 24 * 60 * 60 * 1000, sessionRecord.absoluteExpiresAt.getTime()));

    const newSession = await rotateRefreshSession({
      sessionId: sessionRecord.id,
      userId: user.id,
      rotatedToken: rotatedRefreshToken,
      expiresAt: rollingExpiry,
      userAgent: req.headers.get('user-agent') ?? null,
      ipAddress: req.headers.get('x-forwarded-for') ?? null,
      familyId: sessionRecord.familyId,
      absoluteExpiresAt: sessionRecord.absoluteExpiresAt,
    });
    const accessToken = signToken(user.id, normalizeEmail(user.email), { sessionId: newSession.id, expiresInSeconds: 15 * 60 });

    await recordSecurityEvent(user.id, 'token_refresh');

    const response = NextResponse.json({
      token: accessToken,
      refreshToken: rotatedRefreshToken,
      user: buildUserSummary(user),
    }, { headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    applyAuthCookies(response, {
      accessToken,
      refreshToken: rotatedRefreshToken,
      isProduction: process.env.NODE_ENV === 'production',
    });
    return response;
  } catch (error) {
    if (error instanceof RefreshSessionAlreadyUsedError) {
      return NextResponse.json({ error: 'Refresh token expired' }, { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }
    return NextResponse.json({ error: 'Unable to refresh session' }, { status: 500, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
  }
}
