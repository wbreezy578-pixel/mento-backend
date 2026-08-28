import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { loadAndValidateEnvironment, getJwtSecret as getConfiguredJwtSecret } from '../../lib/env';
import logger from '../../lib/logger';
import { NextResponse } from 'next/server';
import type { ResponseCookies } from 'next/dist/server/web/spec-extension/cookies';

loadAndValidateEnvironment();
const JWT_SECRET = getConfiguredJwtSecret();
const resolvedJwtSecret = JWT_SECRET;

function getJwtSecret(): string | undefined {
  return resolvedJwtSecret;
}

function ensureJwtSecret(): string {
  if (!resolvedJwtSecret) {
    throw new Error('JWT_SECRET must be configured');
  }
  return resolvedJwtSecret;
}

const JWT_ALGORITHM = 'HS256';
const JWT_ISSUER = process.env.JWT_ISSUER ?? 'mento';
const JWT_AUDIENCE = process.env.JWT_AUDIENCE ?? 'mento';
const PASSWORD_MIN_LENGTH = 15;
const PASSWORD_MAX_BYTES = 72;
const RECENT_OAUTH_REAUTH_MS = 15 * 60 * 1000;
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_LOCKOUT_THRESHOLD = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const userContext = new AsyncLocalStorage<{ userId: string; sessionId: string } | null>();

export interface JwtPayload {
  sub: string;
  email: string;
  iat: number;
  exp: number;
  type?: 'access' | 'refresh' | string;
  sid: string;
}

export interface PasswordValidationResult {
  isValid: boolean;
  reasons: string[];
}

export interface SensitiveActionRequirements {
  requiresPasswordConfirmation: boolean;
  requiresRecentOAuthReauth: boolean;
  recentOAuthReauthWindowMs: number;
}

export interface LoginPolicyState {
  allowed: boolean;
  reason: 'allowed' | 'account_locked' | 'invalid_credentials';
  lockoutRemainingSeconds: number;
}

export function getClientIp(req: Request) {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded) return forwarded;
  return req.headers.get('x-real-ip')?.trim() || '';
}

export function getLoginPolicyState(user: { failedLoginAttempts?: number | null; lockedAt?: Date | string | null }) {
  const lockedAt = user?.lockedAt ? new Date(user.lockedAt) : null;
  const now = Date.now();
  if (lockedAt && lockedAt.getTime() > now) {
    return {
      allowed: false,
      reason: 'account_locked' as const,
      lockoutRemainingSeconds: Math.ceil(Math.max(0, lockedAt.getTime() - now) / 1000),
    };
  }
  return {
    allowed: true,
    reason: 'allowed' as const,
    lockoutRemainingSeconds: 0,
  };
}

function extractTokenFromRequest(req: Request): { token: string | null; source: 'authorization' | 'cookie' | 'none' } {
  const headerValue = req.headers.get('authorization')?.trim() ?? '';
  const headerMatch = headerValue.match(/^Bearer\s+(.+)$/i);
  if (headerMatch?.[1]) {
    return { token: headerMatch[1].trim(), source: 'authorization' };
  }

  const cookieHeader = req.headers.get('cookie') ?? '';
  const cookieMatch = cookieHeader.match(/(?:^|;\s*)mento_access_token=([^;]+)/);
  if (cookieMatch?.[1]) {
    return { token: decodeURIComponent(cookieMatch[1]).trim(), source: 'cookie' };
  }

  return { token: null, source: 'none' };
}

export async function getUserFromRequest(req: Request) {
  const { token } = extractTokenFromRequest(req);
  const tokenPresent = Boolean(token);

  if (!tokenPresent || !token) {
    userContext.enterWith(null);
    return null;
  }

  try {
    const jwtSecret = getJwtSecret();
    if (!jwtSecret) {
      logger.warn('JWT_SECRET not configured: auth verification is disabled');
      userContext.enterWith(null);
      return null;
    }
    const payload = jwt.verify(token, jwtSecret, {
      algorithms: [JWT_ALGORITHM],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }) as Partial<JwtPayload>;
    if (typeof payload !== 'object' || payload === null || typeof (payload as Partial<JwtPayload>).sub !== 'string' || typeof (payload as Partial<JwtPayload>).email !== 'string' || typeof (payload as Partial<JwtPayload>).sid !== 'string') {
      logger.warn('Auth rejected: invalid JWT payload');
      userContext.enterWith(null);
      return null;
    }

    if ((payload as JwtPayload).type === 'refresh') {
      logger.warn('Auth rejected: refresh token used as access token');
      userContext.enterWith(null);
      return null;
    }

    const userId = (payload as JwtPayload).sub;
    const sessionId = (payload as JwtPayload).sid;

    const [user, session] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId } }),
      prisma.session.findFirst({ where: { id: sessionId, userId, revokedAt: null, expiresAt: { gt: new Date() }, absoluteExpiresAt: { gt: new Date() } } }),
    ]);

    const userFound = Boolean(user);
    const issuedAt = typeof payload.iat === 'number' ? payload.iat * 1000 : 0;
    if (!userFound || !user || !session || user.accountStatus !== 'ACTIVE' || issuedAt < user.credentialsChangedAt.getTime() - 1000) {
      logger.warn('Auth rejected: user lookup failed');
      userContext.enterWith(null);
      return null;
    }

    userContext.enterWith({ userId: user.id, sessionId });
    if (!session.lastUsedAt || Date.now() - session.lastUsedAt.getTime() > 5 * 60 * 1000) {
      void prisma.session.update({ where: { id: sessionId }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    }
    return user;
  } catch (error: unknown) {
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    const tokenExpired = errorName === 'TokenExpiredError';
    logger.warn('JWT verification failed', {
      errorName,
      tokenPresent,
      tokenExpired,
      algorithm: JWT_ALGORITHM,
    });
    userContext.enterWith(null);
    return null;
  }
}

export function normalizeEmail(email: string | null | undefined) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

export function isBcryptHash(hash: string) {
  // Accept common bcrypt prefixes and a base64-like payload of variable length
  return /^\$2[abxy]?\$\d{2}\$[./A-Za-z0-9]+$/.test(hash);
}

export function isAdminUser(user: { email?: string | null; authProvider?: string | null; role?: string | null }) {
  const configuredAdminEmails = process.env.ADMIN_EMAILS?.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean) ?? [];
  const normalizedEmail = normalizeEmail(user.email);

  if (user.authProvider === 'admin') {
    return true;
  }

  if (typeof user.role === 'string' && user.role.trim().toLowerCase() === 'admin') {
    return true;
  }

  return normalizedEmail.length > 0 && configuredAdminEmails.includes(normalizedEmail);
}

export function validatePasswordStrength(password: string): PasswordValidationResult {
  const reasons: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) {
    reasons.push(`Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`);
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) reasons.push(`Password must be at most ${PASSWORD_MAX_BYTES} bytes long.`);
  return { isValid: reasons.length === 0, reasons };
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, passwordHash: string | null | undefined) {
  if (!passwordHash || !passwordHash.trim()) return false;

  const trimmedHash = passwordHash.trim();
  const isBcrypt = isBcryptHash(trimmedHash);

  if (isBcrypt) {
    try {
      return await bcrypt.compare(password, trimmedHash);
    } catch (error) {
      logger.warn('Password verification failed due to invalid bcrypt hash', {
        error: error instanceof Error ? error.message : String(error),
        hashLength: trimmedHash.length,
      });
      return false;
    }
  }

  logger.warn('Rejected account with unsupported legacy password format', {
    hashLength: trimmedHash.length,
    category: 'legacy_password_rejected',
  });
  return false;
}

export function authRateLimitSubject(value: string) {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex').slice(0, 32);
}

export function getSensitiveActionRequirements(user: { authProvider?: string | null; lastOAuthReauthAt?: Date | string | null }, now = new Date()): SensitiveActionRequirements {
  const lastOAuthReauthAt = user.lastOAuthReauthAt ? new Date(user.lastOAuthReauthAt) : null;
  const isOAuthUser = user.authProvider === 'google' || user.authProvider === 'apple' || user.authProvider === 'mixed';
  const recentOAuthReauth = lastOAuthReauthAt ? now.getTime() - lastOAuthReauthAt.getTime() <= RECENT_OAUTH_REAUTH_MS : false;
  return {
    requiresPasswordConfirmation: true,
    requiresRecentOAuthReauth: isOAuthUser && !recentOAuthReauth,
    recentOAuthReauthWindowMs: RECENT_OAUTH_REAUTH_MS,
  };
}

export function requireUserScope(requestedUserId: string | null | undefined) {
  const activeUserId = getActiveUserId();
  if (!activeUserId || !requestedUserId || activeUserId !== requestedUserId) {
    throw new Error('Forbidden');
  }
  return activeUserId;
}

export function buildUserSummary(user: { id: string; email: string; name?: string | null }) {
  return { id: user.id, email: user.email, name: user.name ?? null };
}

export function signToken(userId: string, email: string, options: { sessionId: string; expiresInSeconds?: number }) {
  const jwtSecret = ensureJwtSecret();
  const expiresInSeconds = options?.expiresInSeconds ?? ACCESS_TOKEN_TTL_SECONDS;

  return jwt.sign({ sub: userId, email, sid: options.sessionId, type: 'access' }, jwtSecret, {
    expiresIn: expiresInSeconds,
    algorithm: JWT_ALGORITHM,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
}

export function signRefreshToken(userId: string, email: string) {
  const jwtSecret = ensureJwtSecret();
  return jwt.sign({ sub: userId, email, type: 'refresh' }, jwtSecret, {
    expiresIn: REFRESH_TOKEN_TTL_SECONDS,
    algorithm: JWT_ALGORITHM,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
}

export function isTokenExpired(expirationUnixSeconds: number | null | undefined) {
  if (typeof expirationUnixSeconds !== 'number') return true;
  return Math.floor(Date.now() / 1000) >= expirationUnixSeconds;
}

export function buildAuthCookieOptions(params: { isProduction: boolean; maxAgeSeconds: number; path?: string }): Parameters<ResponseCookies['set']>[2] {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: params.isProduction,
    path: params.path ?? '/',
    maxAge: params.maxAgeSeconds,
    domain: params.isProduction ? undefined : undefined,
  };
}

export function applyAuthCookies(
  response: NextResponse,
  params: { accessToken: string; refreshToken: string; isProduction: boolean; accessMaxAgeSeconds?: number; refreshMaxAgeSeconds?: number; path?: string }
) {
  response.cookies.set('mento_access_token', params.accessToken, buildAuthCookieOptions({
    isProduction: params.isProduction,
    maxAgeSeconds: params.accessMaxAgeSeconds ?? ACCESS_TOKEN_TTL_SECONDS,
    path: params.path,
  }));
  response.cookies.set('mento_refresh_token', params.refreshToken, buildAuthCookieOptions({
    isProduction: params.isProduction,
    maxAgeSeconds: params.refreshMaxAgeSeconds ?? REFRESH_TOKEN_TTL_SECONDS,
    path: params.path,
  }));
  return response;
}

export async function recordSecurityEvent(userId: string | null, eventType: string, details: Record<string, unknown> = {}) {
  try {
    await prisma.securityEvent.create({ data: { userId, eventType, severity: 'info', details: details as Prisma.InputJsonValue } });
  } catch (error) {
    logger.warn('Security event persistence failed', { error });
  }
}

export async function incrementFailedLoginAttempts(userId: string) {
  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      failedLoginAttempts: { increment: 1 },
      lastFailedLoginAt: new Date(),
    },
  });
  if (updated.failedLoginAttempts >= LOGIN_LOCKOUT_THRESHOLD) {
    return prisma.user.update({ where: { id: userId }, data: { lockedAt: new Date(Date.now() + LOGIN_LOCKOUT_MS) } });
  }
  return updated;
}

export async function resetFailedLoginAttempts(userId: string) {
  await prisma.user.update({
    where: { id: userId },
    data: {
      failedLoginAttempts: 0,
      lockedAt: null,
      lastLoginAt: new Date(),
    },
  });
}

export function getActiveUserId() {
  return userContext.getStore()?.userId ?? null;
}

export function getActiveSessionId() {
  return userContext.getStore()?.sessionId ?? null;
}

export function getUserContextForPrisma() {
  return getActiveUserId();
}
