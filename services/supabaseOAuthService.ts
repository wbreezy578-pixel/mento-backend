import { NextResponse } from 'next/server';
import { applyAuthCookies, buildUserSummary, normalizeEmail, recordSecurityEvent, signToken } from '../app/lib/auth';
import { createSessionRecord, generateSecureToken } from '../lib/authSession';
import { getSupabaseClientKey, getSupabaseUrl } from '../lib/env';
import { buildCorsHeaders } from '../lib/securityHeaders';
import { createAppleAccount, createGoogleOAuthAccount } from './userAccountService';
import { CURRENT_LEGAL_VERSIONS } from '../lib/legalVersions';
import { prisma } from '../lib/prisma';
import { randomUUID } from 'crypto';
import { validateLegalAcceptance } from '../lib/legalConsent';

export type OAuthProvider = 'google' | 'apple';
const CORS_METHODS = 'POST, OPTIONS';

export function oauthOptions(req: Request) {
  return new NextResponse(null, { status: 204, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
}

function headers(req: Request) {
  return { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS };
}

export async function exchangeSupabaseOAuth(req: Request, provider: OAuthProvider) {
  try {
    const body = await req.json() as { access_token?: unknown; ageConfirmed?: unknown; legalVersions?: typeof CURRENT_LEGAL_VERSIONS };
    if (typeof body.access_token !== 'string' || !body.access_token.trim()) {
      return NextResponse.json({ error: 'Supabase access token is required' }, { status: 400, headers: headers(req) });
    }
    const legalError = validateLegalAcceptance(body);
    if (legalError) return NextResponse.json({ error: legalError }, { status: legalError.includes('18') ? 400 : 409, headers: headers(req) });
    const response = await fetch(`${getSupabaseUrl()}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${body.access_token.trim()}`, apikey: getSupabaseClientKey() },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return NextResponse.json({ error: 'Invalid Supabase access token' }, { status: 401, headers: headers(req) });
    const profile = await response.json() as {
      id?: unknown; email?: unknown; app_metadata?: { provider?: unknown; providers?: unknown };
      identities?: Array<{ provider?: unknown }>;
      user_metadata?: { full_name?: unknown; name?: unknown };
    };
    const providers = new Set<string>();
    if (typeof profile.app_metadata?.provider === 'string') providers.add(profile.app_metadata.provider);
    if (Array.isArray(profile.app_metadata?.providers)) profile.app_metadata.providers.forEach((value) => typeof value === 'string' && providers.add(value));
    profile.identities?.forEach((identity) => typeof identity.provider === 'string' && providers.add(identity.provider));
    if (!providers.has(provider)) return NextResponse.json({ error: `The Supabase token is not authenticated with ${provider}.` }, { status: 401, headers: headers(req) });
    const email = normalizeEmail(typeof profile.email === 'string' ? profile.email : '');
    if (typeof profile.id !== 'string' || !email) return NextResponse.json({ error: 'OAuth provider did not return a verified email.' }, { status: 400, headers: headers(req) });
    const metadataName = typeof profile.user_metadata?.full_name === 'string' ? profile.user_metadata.full_name : typeof profile.user_metadata?.name === 'string' ? profile.user_metadata.name : '';
    const account = provider === 'apple'
      ? await createAppleAccount({ email, name: metadataName || email.split('@')[0] })
      : await createGoogleOAuthAccount({ email, name: metadataName || email.split('@')[0] });
    const user = account.user;
    await prisma.$executeRaw`
      INSERT INTO "ConsentRecord" ("id", "userId", "privacyVersion", "termsVersion", "aiNoticeVersion", "source", "acceptedAt", "revokedAt")
      VALUES (${randomUUID()}, ${user.id}, ${CURRENT_LEGAL_VERSIONS.privacy}, ${CURRENT_LEGAL_VERSIONS.terms}, ${CURRENT_LEGAL_VERSIONS.aiNotice}, ${`${provider}-android`}, ${new Date()}, NULL)
      ON CONFLICT ("userId", "privacyVersion", "termsVersion", "aiNoticeVersion") DO NOTHING
    `;
    const accessToken = signToken(user.id, email, { expiresInSeconds: 15 * 60 });
    const refreshToken = generateSecureToken();
    const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await createSessionRecord({ userId: user.id, token: refreshToken, userAgent: req.headers.get('user-agent'), ipAddress: req.headers.get('x-forwarded-for'), expiresAt: sessionExpiresAt });
    await recordSecurityEvent(user.id, 'oauth_login_success', { provider });
    const result = NextResponse.json({ token: accessToken, refreshToken, sessionExpiresAt: sessionExpiresAt.toISOString(), user: buildUserSummary(user) }, { headers: headers(req) });
    applyAuthCookies(result, { accessToken, refreshToken, isProduction: process.env.NODE_ENV === 'production' });
    return result;
  } catch {
    return NextResponse.json({ error: `${provider === 'apple' ? 'Apple' : 'Google'} sign-in is temporarily unavailable.` }, { status: 503, headers: headers(req) });
  }
}
