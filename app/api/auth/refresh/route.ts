import { NextResponse } from 'next/server';
import { signToken, normalizeEmail, recordSecurityEvent, buildUserSummary, applyAuthCookies, getClientIp, getSessionClientIp, getRefreshTokenFromBrowserCookie, isBrowserAuthRequest, buildAuthSessionResponseBody } from '../../../lib/auth';
import { detectRefreshContextChange, findSessionByToken, generateSecureToken, getRefreshSessionExpiry, hashClientDeviceId, hasSessionDeviceMismatch, isRefreshSessionExpired, RefreshSessionAlreadyUsedError, revokeSessionFamily, rotateRefreshSession } from '../../../../lib/authSession';
import { buildCorsHeaders } from '../../../../lib/securityHeaders';
import { ensureSlidingWindow } from '../../../../lib/rateLimiter';
import { createNotification } from '../../../services/notificationService';

const CORS_METHODS = 'POST, OPTIONS';

async function notifySessionSecurity(userId: string, body: string, externalId?: string) {
  try {
    await createNotification(userId, {
      title: 'Session security alert',
      body,
      type: 'security',
      category: 'SECURITY',
      externalId,
    });
  } catch {
    // Security notifications are best-effort and must never change auth behavior.
  }
}

export async function OPTIONS(req: Request) {
  const corsHeaders = buildCorsHeaders(req.headers.get('origin'));
  return new NextResponse(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Allow-Methods': CORS_METHODS } });
}

export async function POST(req: Request) {
  let sessionRecord: Awaited<ReturnType<typeof findSessionByToken>> = null;
  try {
    const limit = await ensureSlidingWindow(`refresh:ip:${getClientIp(req)}`, 60, 15 * 60);
    if (!limit.ok) return NextResponse.json({ error: 'Too many refresh attempts. Please try again later.' }, { status: 429, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    const body = await req.json();
    const refreshToken = getRefreshTokenFromBrowserCookie(req)
      ?? (typeof body?.refreshToken === 'string' ? body.refreshToken.trim() : '');
    if (!refreshToken) {
      return NextResponse.json({ error: 'Refresh token required' }, { status: 400, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    sessionRecord = await findSessionByToken(refreshToken);

    if (!sessionRecord) {
      return NextResponse.json({ error: 'Refresh token expired' }, { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    if (sessionRecord.revokedAt || sessionRecord.replacedBySessionId) {
      await revokeSessionFamily(sessionRecord.familyId);
      await recordSecurityEvent(sessionRecord.userId, 'refresh_token_reuse_detected', { familyId: sessionRecord.familyId });
      await notifySessionSecurity(
        sessionRecord.userId,
        'A reused sign-in session was blocked. Please sign in again if this was you.',
        `security:refresh-token-reuse:${sessionRecord.familyId}`,
      );
      return NextResponse.json({ error: 'Session security check failed. Please sign in again.' }, { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    if (isRefreshSessionExpired(sessionRecord)) {
      return NextResponse.json({ error: 'Refresh token expired' }, { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const user = sessionRecord.user;
    if (!user.emailVerified || user.accountStatus !== 'ACTIVE') return NextResponse.json({ error: 'Account is not active.' }, { status: 403, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    const currentDeviceIdHash = hashClientDeviceId(req.headers.get('x-mento-device-id'));
    if (hasSessionDeviceMismatch(sessionRecord.deviceIdHash, currentDeviceIdHash)) {
      await revokeSessionFamily(sessionRecord.familyId);
      await recordSecurityEvent(user.id, 'refresh_device_mismatch', {
        sessionId: sessionRecord.id,
        familyId: sessionRecord.familyId,
        deviceIdProvided: Boolean(currentDeviceIdHash),
      });
      await notifySessionSecurity(
        user.id,
        'A sign-in session was blocked on an unrecognized device. Please sign in again if this was you.',
        `security:refresh-device-mismatch:${sessionRecord.familyId}`,
      );
      return NextResponse.json({ error: 'Session security check failed. Please sign in again.' }, { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }
    const currentUserAgent = req.headers.get('user-agent') ?? null;
    const currentIpAddress = getSessionClientIp(req);
    const contextChange = detectRefreshContextChange({
      previousIpAddress: sessionRecord.ipAddress,
      currentIpAddress,
      previousUserAgent: sessionRecord.userAgent,
      currentUserAgent,
    });
    if (contextChange.changed) {
      await recordSecurityEvent(user.id, 'refresh_context_changed', {
        sessionId: sessionRecord.id,
        familyId: sessionRecord.familyId,
        ipChanged: contextChange.ipChanged,
        userAgentChanged: contextChange.userAgentChanged,
      });
      // Do not block refresh on notification persistence, especially when a
      // mobile carrier changes the client's IP between requests.
      void notifySessionSecurity(
        user.id,
        'Your Mento session was refreshed from a different network or app version. If this was not you, sign in again and review your sessions.',
        `security:refresh-context:${sessionRecord.id}`,
      );
    }
    const rotatedRefreshToken = generateSecureToken();
    const rollingExpiry = getRefreshSessionExpiry(sessionRecord.absoluteExpiresAt);

    const newSession = await rotateRefreshSession({
      sessionId: sessionRecord.id,
      userId: user.id,
      rotatedToken: rotatedRefreshToken,
      expiresAt: rollingExpiry,
      userAgent: currentUserAgent,
      ipAddress: currentIpAddress,
      deviceIdHash: currentDeviceIdHash,
      familyId: sessionRecord.familyId,
      absoluteExpiresAt: sessionRecord.absoluteExpiresAt,
    });
    const accessToken = signToken(user.id, normalizeEmail(user.email), { sessionId: newSession.id, expiresInSeconds: 15 * 60 });

    await recordSecurityEvent(user.id, 'token_refresh');

    const browserSession = isBrowserAuthRequest(req);
    const response = NextResponse.json(buildAuthSessionResponseBody({
      browserSession,
      accessToken,
      refreshToken: rotatedRefreshToken,
      sessionExpiresAt: newSession.expiresAt.toISOString(),
      user: buildUserSummary(user),
    }), { headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    applyAuthCookies(response, {
      accessToken,
      refreshToken: rotatedRefreshToken,
      isProduction: process.env.NODE_ENV === 'production',
      browserSession,
    });
    return response;
  } catch (error) {
    if (error instanceof RefreshSessionAlreadyUsedError) {
      // A raced or replayed refresh token invalidates the complete family,
      // including the winning replacement, so an attacker cannot continue a
      // stolen branch after reuse is detected.
      if (sessionRecord) {
        await revokeSessionFamily(sessionRecord.familyId).catch(() => undefined);
        await recordSecurityEvent(sessionRecord.userId, 'refresh_token_reuse_detected', { familyId: sessionRecord.familyId, source: 'rotation_race' });
        await notifySessionSecurity(
          sessionRecord.userId,
          'A reused sign-in session was blocked. Please sign in again if this was you.',
          `security:refresh-token-reuse:${sessionRecord.familyId}`,
        );
      }
      return NextResponse.json({ error: 'Refresh token expired' }, { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }
    return NextResponse.json({ error: 'Unable to refresh session' }, { status: 500, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
  }
}
