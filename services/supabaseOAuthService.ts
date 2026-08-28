import { NextResponse } from 'next/server';
import { applyAuthCookies, authRateLimitSubject, buildUserSummary, getClientIp, getUserFromRequest, normalizeEmail, recordSecurityEvent, signToken } from '../app/lib/auth';
import { createSessionRecord, generateSecureToken } from '../lib/authSession';
import { getSupabaseClientKey, getSupabaseUrl } from '../lib/env';
import { buildCorsHeaders } from '../lib/securityHeaders';
import { createAppleAccount, createGoogleOAuthAccount } from './userAccountService';
import { CURRENT_LEGAL_VERSIONS } from '../lib/legalVersions';
import { prisma } from '../lib/prisma';
import { randomUUID } from 'crypto';
import { validateLegalAcceptance } from '../lib/legalConsent';
import { ensureSlidingWindow } from '../lib/rateLimiter';

export type OAuthProvider = 'google' | 'apple';
const CORS_METHODS = 'POST, OPTIONS';

export function oauthOptions(req: Request) {
  return new NextResponse(null, { status: 204, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
}

function headers(req: Request) {
  return { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS };
}

interface VerifiedOAuthProfile {
  externalUserId: string;
  email: string;
  name: string;
}

async function verifySupabaseOAuthToken(accessToken: string, provider: OAuthProvider): Promise<VerifiedOAuthProfile | null> {
  const response = await fetch(`${getSupabaseUrl()}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${accessToken}`, apikey: getSupabaseClientKey() },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return null;

  const profile = await response.json() as {
    id?: unknown; email?: unknown; email_confirmed_at?: unknown; app_metadata?: { provider?: unknown; providers?: unknown };
    identities?: Array<{ provider?: unknown }>;
    user_metadata?: { full_name?: unknown; name?: unknown };
  };
  const providers = new Set<string>();
  if (typeof profile.app_metadata?.provider === 'string') providers.add(profile.app_metadata.provider);
  if (Array.isArray(profile.app_metadata?.providers)) profile.app_metadata.providers.forEach((value) => typeof value === 'string' && providers.add(value));
  profile.identities?.forEach((identity) => typeof identity.provider === 'string' && providers.add(identity.provider));
  const email = normalizeEmail(typeof profile.email === 'string' ? profile.email : '');
  if (!providers.has(provider) || typeof profile.id !== 'string' || !email || typeof profile.email_confirmed_at !== 'string') return null;
  const metadataName = typeof profile.user_metadata?.full_name === 'string'
    ? profile.user_metadata.full_name
    : typeof profile.user_metadata?.name === 'string' ? profile.user_metadata.name : '';
  return { externalUserId: profile.id, email, name: metadataName || email.split('@')[0] };
}

async function enforceOAuthLimits(req: Request, provider: OAuthProvider, accountSubject?: string) {
  const clientIp = getClientIp(req);
  const limits = [ensureSlidingWindow(`oauth:${provider}:ip:${clientIp}`, 20, 15 * 60)];
  if (accountSubject) limits.push(ensureSlidingWindow(`oauth:${provider}:account:${authRateLimitSubject(accountSubject)}`, 10, 15 * 60));
  const results = await Promise.all(limits);
  return results.every((result) => result.ok);
}

export async function exchangeSupabaseOAuth(req: Request, provider: OAuthProvider) {
  try {
    if (!await enforceOAuthLimits(req, provider)) {
      return NextResponse.json({ error: 'Too many sign-in attempts. Please try again later.' }, { status: 429, headers: headers(req) });
    }
    const body = await req.json() as { access_token?: unknown; ageConfirmed?: unknown; legalVersions?: typeof CURRENT_LEGAL_VERSIONS };
    if (typeof body.access_token !== 'string' || !body.access_token.trim()) {
      return NextResponse.json({ error: 'Supabase access token is required' }, { status: 400, headers: headers(req) });
    }
    const legalError = validateLegalAcceptance(body);
    if (legalError) return NextResponse.json({ error: legalError }, { status: legalError.includes('18') ? 400 : 409, headers: headers(req) });
    const profile = await verifySupabaseOAuthToken(body.access_token.trim(), provider);
    if (!profile) return NextResponse.json({ error: 'OAuth identity could not be verified.' }, { status: 401, headers: headers(req) });
    const accountLimit = await ensureSlidingWindow(`oauth:${provider}:account:${authRateLimitSubject(profile.externalUserId)}`, 10, 15 * 60);
    if (!accountLimit.ok) {
      return NextResponse.json({ error: 'Too many sign-in attempts. Please try again later.' }, { status: 429, headers: headers(req) });
    }
    const account = provider === 'apple'
      ? await createAppleAccount({ email: profile.email, name: profile.name, externalUserId: profile.externalUserId })
      : await createGoogleOAuthAccount({ email: profile.email, name: profile.name, externalUserId: profile.externalUserId });
    const user = account.user;
    await prisma.$executeRaw`
      INSERT INTO "ConsentRecord" ("id", "userId", "privacyVersion", "termsVersion", "aiNoticeVersion", "source", "acceptedAt", "revokedAt")
      VALUES (${randomUUID()}, ${user.id}, ${CURRENT_LEGAL_VERSIONS.privacy}, ${CURRENT_LEGAL_VERSIONS.terms}, ${CURRENT_LEGAL_VERSIONS.aiNotice}, ${`${provider}-android`}, ${new Date()}, NULL)
      ON CONFLICT ("userId", "privacyVersion", "termsVersion", "aiNoticeVersion") DO NOTHING
    `;
    const refreshToken = generateSecureToken();
    const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const session = await createSessionRecord({ userId: user.id, token: refreshToken, userAgent: req.headers.get('user-agent'), ipAddress: req.headers.get('x-forwarded-for'), expiresAt: sessionExpiresAt });
    const accessToken = signToken(user.id, profile.email, { sessionId: session.id, expiresInSeconds: 15 * 60 });
    await recordSecurityEvent(user.id, 'oauth_login_success', { provider });
    const result = NextResponse.json({ token: accessToken, refreshToken, sessionExpiresAt: sessionExpiresAt.toISOString(), user: buildUserSummary(user) }, { headers: headers(req) });
    applyAuthCookies(result, { accessToken, refreshToken, isProduction: process.env.NODE_ENV === 'production' });
    return result;
  } catch {
    return NextResponse.json({ error: `${provider === 'apple' ? 'Apple' : 'Google'} sign-in is temporarily unavailable.` }, { status: 503, headers: headers(req) });
  }
}

export async function reauthenticateSupabaseOAuth(req: Request, provider: OAuthProvider) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: headers(req) });
    if (!await enforceOAuthLimits(req, provider, user.id)) {
      return NextResponse.json({ error: 'Too many re-authentication attempts. Please try again later.' }, { status: 429, headers: headers(req) });
    }
    const body = await req.json().catch(() => ({})) as { access_token?: unknown };
    if (typeof body.access_token !== 'string' || !body.access_token.trim()) {
      return NextResponse.json({ error: 'Provider authentication token is required.' }, { status: 400, headers: headers(req) });
    }
    const profile = await verifySupabaseOAuthToken(body.access_token.trim(), provider);
    const linkedProvider = user.authProvider === provider || (user.authProvider === 'mixed' && user.oauthProvider === provider);
    if (!profile || !linkedProvider || !user.supabaseUserId || profile.externalUserId !== user.supabaseUserId) {
      await recordSecurityEvent(user.id, 'oauth_reauthentication_rejected', { provider });
      return NextResponse.json({ error: 'That provider account does not match your current Mento account.' }, { status: 403, headers: headers(req) });
    }
    await prisma.user.update({ where: { id: user.id }, data: { lastOAuthReauthAt: new Date() } });
    await recordSecurityEvent(user.id, 'oauth_reauthentication_completed', { provider });
    return NextResponse.json({ ok: true, user: buildUserSummary(user) }, { headers: headers(req) });
  } catch {
    return NextResponse.json({ error: 'Re-authentication is temporarily unavailable.' }, { status: 503, headers: headers(req) });
  }
}
