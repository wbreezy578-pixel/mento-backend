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
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

function getJwtSecret(): string | undefined {
  return resolvedJwtSecret;
}

function getJwtSecretFingerprint(secret: string | undefined): string | null {
  if (!secret) return null;
  return createHash('sha256').update(secret).digest('hex');
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
const PASSWORD_MIN_LENGTH = 12;
const RECENT_OAUTH_REAUTH_MS = 15 * 60 * 1000;
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const userContext = new AsyncLocalStorage<string | null>();

export interface JwtPayload {
  sub: string;
  email: string;
  iat: number;
  exp: number;
  type?: 'access' | 'refresh' | string;
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
  const authHeader = req.headers.get('authorization')?.trim() || '';
  const authHeaderExists = authHeader.length > 0;
  const authScheme = authHeaderExists ? authHeader.split(' ')[0] : 'none';
  const { token, source: tokenSource } = extractTokenFromRequest(req);
  const tokenPresent = Boolean(token);
  logger.info('Auth header inspection', { authHeaderExists, authScheme, tokenPresent, tokenSource });

  if (!tokenPresent || !token) {
    logger.warn('Auth rejected: missing token', { tokenSource });
    userContext.enterWith(null);
    return null;
  }

  logger.info('JWT verification started');
  try {
    const jwtSecret = getJwtSecret();
    logger.info('JWT verification configuration', {
      jwtSecretConfigured: Boolean(jwtSecret),
      jwtSecretFingerprint: getJwtSecretFingerprint(jwtSecret),
      algorithm: JWT_ALGORITHM,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
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
    const decodedUserId = typeof payload === 'object' && payload !== null ? (payload as Partial<JwtPayload>).sub ?? null : null;
    const decodedEmail = typeof payload === 'object' && payload !== null ? (payload as Partial<JwtPayload>).email ?? null : null;
    const decodedIat = typeof payload === 'object' && payload !== null ? (payload as Partial<JwtPayload>).iat ?? null : null;
    const decodedExp = typeof payload === 'object' && payload !== null ? (payload as Partial<JwtPayload>).exp ?? null : null;
    logger.info('JWT verification succeeded', {
      decodedUserId,
      decodedEmail,
      decodedIat,
      decodedExp,
      algorithm: JWT_ALGORITHM,
      secretConfigured: Boolean(jwtSecret),
      nowUnixSeconds: Math.floor(Date.now() / 1000),
      tokenAgeSeconds: typeof decodedIat === 'number' ? Math.floor(Date.now() / 1000) - decodedIat : null,
      tokenExpiresInSeconds: typeof decodedExp === 'number' ? decodedExp - Math.floor(Date.now() / 1000) : null,
    });

    if (typeof payload !== 'object' || payload === null || typeof (payload as Partial<JwtPayload>).sub !== 'string' || typeof (payload as Partial<JwtPayload>).email !== 'string') {
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
    const email = (payload as JwtPayload).email;
    logger.info('JWT payload extracted', { userId, email });

    const user = await prisma.user.findUnique({ where: { id: userId } });

    const userFound = Boolean(user);
    logger.info('User lookup result', { userFound, userId, userEmail: user?.email ?? null });
    if (!userFound || !user) {
      logger.warn('Auth rejected: user lookup failed');
      userContext.enterWith(null);
      return null;
    }

    userContext.enterWith(user.id);
    return user;
  } catch (error: unknown) {
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const tokenExpired = errorName === 'TokenExpiredError';
    logger.warn('JWT verification failed', {
      errorName,
      errorMessage,
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
  if (!/[A-Z]/.test(password)) {
    reasons.push('Password must contain an uppercase letter.');
  }
  if (!/[a-z]/.test(password)) {
    reasons.push('Password must contain a lowercase letter.');
  }
  if (!/\d/.test(password)) {
    reasons.push('Password must contain a number.');
  }
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password)) {
    reasons.push('Password must contain a symbol.');
  }
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

  // Legacy compatibility: some older or migrated accounts may have stored passwords in plain text.
  // Only accept raw matches for non-bcrypt strings to avoid degrading bcrypt-based security.
  return password === trimmedHash;
}

export function getSensitiveActionRequirements(user: { authProvider?: string | null; lastOAuthReauthAt?: Date | string | null }, now = new Date()): SensitiveActionRequirements {
  const lastOAuthReauthAt = user.lastOAuthReauthAt ? new Date(user.lastOAuthReauthAt) : null;
  const isGoogleUser = user.authProvider === 'google' || user.authProvider === 'mixed';
  const recentOAuthReauth = lastOAuthReauthAt ? now.getTime() - lastOAuthReauthAt.getTime() <= RECENT_OAUTH_REAUTH_MS : false;
  return {
    requiresPasswordConfirmation: true,
    requiresRecentOAuthReauth: isGoogleUser && !recentOAuthReauth,
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

export function signToken(userId: string, email: string, options?: { expiresInSeconds?: number }) {
  const jwtSecret = ensureJwtSecret();
  const jwtSecretFingerprint = getJwtSecretFingerprint(jwtSecret);
  const expiresInSeconds = options?.expiresInSeconds ?? ACCESS_TOKEN_TTL_SECONDS;

  logger.info('JWT signing configuration', {
    jwtSecretConfigured: true,
    jwtSecretFingerprint,
    algorithm: JWT_ALGORITHM,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresInSeconds,
  });

  return jwt.sign({ sub: userId, email, type: 'access' }, jwtSecret, {
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
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;

  const failedLoginAttempts = user.failedLoginAttempts + 1;
  const shouldLockout = failedLoginAttempts >= MAX_FAILED_LOGIN_ATTEMPTS;
  const nextLockedAt = shouldLockout ? new Date(Date.now() + LOCKOUT_DURATION_MS) : user.lockedAt;
  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      failedLoginAttempts,
      lastFailedLoginAt: new Date(),
      lockedAt: nextLockedAt,
    },
  });

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
  return userContext.getStore() ?? null;
}

export function getUserContextForPrisma() {
  return getActiveUserId();
}
