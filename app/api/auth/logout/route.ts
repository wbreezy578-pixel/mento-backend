import { NextResponse } from 'next/server';
import { getUserFromRequest, getActiveSessionId } from '../../../lib/auth';
import { findSessionByToken, revokeAllUserSessions, revokeSession } from '../../../../lib/authSession';
import { buildCorsHeaders } from '../../../../lib/securityHeaders';

const CORS_METHODS = 'POST, OPTIONS';

export async function OPTIONS(req: Request) {
  const corsHeaders = buildCorsHeaders(req.headers.get('origin'));
  return new NextResponse(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Allow-Methods': CORS_METHODS } });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const user = await getUserFromRequest(req);
  if (!user) {
    const refreshToken = typeof body?.refreshToken === 'string' ? body.refreshToken.trim() : '';
    const refreshSession = refreshToken ? await findSessionByToken(refreshToken) : null;
    if (!refreshSession) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    await revokeSession(refreshSession.id);
    return clearLogoutCookies(req);
  }

  if (body?.allDevices === true) await revokeAllUserSessions(user.id);
  else {
    const sessionId = getActiveSessionId();
    if (sessionId) await revokeSession(sessionId);
  }
  return clearLogoutCookies(req);
}

function clearLogoutCookies(req: Request) {
  const response = NextResponse.json({ ok: true }, { headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
  response.cookies.set('mento_access_token', '', { maxAge: 0, path: '/', httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
  response.cookies.set('mento_refresh_token', '', { maxAge: 0, path: '/', httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
  return response;
}
