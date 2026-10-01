import crypto from 'node:crypto';
import { prisma } from './prisma';
import { createHash } from 'node:crypto';

export const REFRESH_SESSION_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const REFRESH_SESSION_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const LOGIN_MFA_TTL_MS = 10 * 60 * 1000;
export const LOGIN_MFA_MAX_ATTEMPTS = 5;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function getRefreshSessionExpiry(absoluteExpiresAt: Date, now = new Date()): Date {
  return new Date(Math.min(now.getTime() + REFRESH_SESSION_IDLE_TTL_MS, absoluteExpiresAt.getTime()));
}

export function isRefreshSessionExpired(
  session: { expiresAt: Date; absoluteExpiresAt: Date },
  now = new Date(),
): boolean {
  return session.expiresAt.getTime() <= now.getTime() || session.absoluteExpiresAt.getTime() <= now.getTime();
}

export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Native clients send an opaque, per-installation identifier in a header. We
 * only persist its hash, so it cannot be used to identify a device outside
 * Mento. Browser sessions intentionally remain cookie-bound instead.
 */
export function hashClientDeviceId(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return DEVICE_ID_PATTERN.test(normalized) ? hashToken(normalized) : null;
}

export function hasSessionDeviceMismatch(previousDeviceIdHash: string | null | undefined, currentDeviceIdHash: string | null | undefined): boolean {
  // Old sessions predate device binding. Let their next successful refresh
  // adopt the device identifier rather than suddenly signing out users.
  if (!previousDeviceIdHash) return false;
  return previousDeviceIdHash !== (currentDeviceIdHash ?? null);
}

export function detectRefreshContextChange(input: {
  previousIpAddress?: string | null;
  currentIpAddress?: string | null;
  previousUserAgent?: string | null;
  currentUserAgent?: string | null;
}) {
  const previousIpAddress = input.previousIpAddress?.trim() ?? '';
  const currentIpAddress = input.currentIpAddress?.trim() ?? '';
  const previousUserAgent = input.previousUserAgent?.trim() ?? '';
  const currentUserAgent = input.currentUserAgent?.trim() ?? '';

  // These values are deliberately risk signals, not authentication factors.
  // Mobile clients can legitimately change networks and User-Agent versions.
  const ipChanged = Boolean(previousIpAddress && currentIpAddress && previousIpAddress !== currentIpAddress);
  const userAgentChanged = Boolean(previousUserAgent && currentUserAgent && previousUserAgent !== currentUserAgent);

  return {
    changed: ipChanged || userAgentChanged,
    ipChanged,
    userAgentChanged,
  };
}

export async function createSessionRecord(input: {
  userId: string;
  token: string;
  userAgent?: string | null;
  ipAddress?: string | null;
  deviceIdHash?: string | null;
  expiresAt: Date;
  familyId?: string;
  parentSessionId?: string | null;
  absoluteExpiresAt?: Date;
}) {
  const familyId = input.familyId ?? crypto.randomUUID();
  const absoluteExpiresAt = input.absoluteExpiresAt ?? new Date(Date.now() + REFRESH_SESSION_ABSOLUTE_TTL_MS);
  return prisma.session.create({
    data: {
      userId: input.userId,
      tokenHash: hashToken(input.token),
      userAgent: input.userAgent ?? null,
      ipAddress: input.ipAddress ?? null,
      deviceIdHash: input.deviceIdHash ?? null,
      expiresAt: input.expiresAt,
      familyId,
      parentSessionId: input.parentSessionId ?? null,
      absoluteExpiresAt,
    },
  });
}

export async function createPasswordResetToken(userId: string, expiresInMinutes = 15) {
  const plainToken = generateSecureToken(32);
  const tokenHash = hashToken(plainToken);

  await prisma.passwordResetToken.updateMany({
    where: { userId, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    data: { revokedAt: new Date() },
  });

  await prisma.passwordResetToken.create({
    data: {
      userId,
      tokenHash,
      expiresAt: new Date(Date.now() + expiresInMinutes * 60 * 1000),
    },
  });

  return plainToken;
}

export async function consumePasswordResetToken(token: string) {
  const tokenHash = hashToken(token);
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const passwordResetToken = await tx.passwordResetToken.findFirst({
      where: {
        tokenHash,
        usedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      include: { user: true },
    });

    if (!passwordResetToken) return null;

    const claimed = await tx.passwordResetToken.updateMany({
      where: { id: passwordResetToken.id, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now, revokedAt: now },
    });

    return claimed.count === 1 ? passwordResetToken : null;
  });
}

export async function findSessionByToken(token: string) {
  const tokenHash = hashToken(token);
  const session = await prisma.session.findFirst({
    where: { tokenHash },
    include: { user: true },
  });

  return session;
}

export async function createEmailActionToken(input: {
  userId: string;
  purpose: 'VERIFY_EMAIL' | 'CHANGE_EMAIL';
  targetEmail?: string | null;
  expiresInMinutes?: number;
}) {
  const plainToken = generateSecureToken(32);
  const now = new Date();
  await prisma.$transaction([
    prisma.emailActionToken.updateMany({
      where: { userId: input.userId, purpose: input.purpose, usedAt: null, revokedAt: null },
      data: { revokedAt: now },
    }),
    prisma.emailActionToken.create({
      data: {
        userId: input.userId,
        tokenHash: hashToken(plainToken),
        purpose: input.purpose,
        targetEmail: input.targetEmail ?? null,
        expiresAt: new Date(now.getTime() + (input.expiresInMinutes ?? 30) * 60 * 1000),
      },
    }),
  ]);
  return plainToken;
}

export async function consumeEmailActionToken(token: string, purpose: 'VERIFY_EMAIL' | 'CHANGE_EMAIL') {
  return prisma.$transaction(async (tx) => {
    const record = await tx.emailActionToken.findFirst({
      where: { tokenHash: hashToken(token), purpose, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      include: { user: true },
    });
    if (!record) return null;
    const claimed = await tx.emailActionToken.updateMany({
      where: { id: record.id, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date(), revokedAt: new Date() },
    });
    return claimed.count === 1 ? record : null;
  });
}

export class RefreshSessionAlreadyUsedError extends Error {
  constructor() {
    super('Refresh session has already been rotated or revoked.');
    this.name = 'RefreshSessionAlreadyUsedError';
  }
}

export async function rotateRefreshSession(input: {
  sessionId: string;
  userId: string;
  rotatedToken: string;
  expiresAt: Date;
  userAgent?: string | null;
  ipAddress?: string | null;
  deviceIdHash?: string | null;
  familyId: string;
  absoluteExpiresAt: Date;
}) {
  return prisma.$transaction(async (transaction) => {
    const claimed = await transaction.session.updateMany({
      where: {
        id: input.sessionId,
        userId: input.userId,
        familyId: input.familyId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        absoluteExpiresAt: { gt: new Date() },
      },
      data: {
        revokedAt: new Date(),
        updatedAt: new Date(),
      },
    });

    if (claimed.count !== 1) {
      throw new RefreshSessionAlreadyUsedError();
    }

    const replacement = await transaction.session.create({
      data: {
        userId: input.userId,
        tokenHash: hashToken(input.rotatedToken),
        expiresAt: input.expiresAt,
        userAgent: input.userAgent ?? null,
        ipAddress: input.ipAddress ?? null,
        deviceIdHash: input.deviceIdHash ?? null,
        familyId: input.familyId,
        parentSessionId: input.sessionId,
        absoluteExpiresAt: input.absoluteExpiresAt,
      },
    });

    await transaction.session.update({
      where: { id: input.sessionId },
      data: { replacedBySessionId: replacement.id },
    });

    return replacement;
  });
}

export async function revokeSessionFamily(familyId: string) {
  await prisma.session.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function revokeSession(sessionId: string) {
  await prisma.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllUserSessions(userId: string) {
  await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export function generateSecureToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

export async function createLoginMfaChallenge(userId: string, input?: { deviceIdHash?: string | null }) {
  const challengeToken = generateSecureToken(32);
  const code = crypto.randomInt(100000, 1000000).toString();
  const now = new Date();
  await prisma.$transaction([
    prisma.loginChallenge.updateMany({
      where: { userId, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    }),
    prisma.loginChallenge.create({
      data: {
        userId,
        challengeHash: hashToken(challengeToken),
        codeHash: hashToken(code),
        deviceIdHash: input?.deviceIdHash ?? null,
        expiresAt: new Date(now.getTime() + LOGIN_MFA_TTL_MS),
      },
    }),
  ]);
  return { challengeToken, code };
}

export class LoginMfaChallengeContextMismatchError extends Error {
  constructor(public readonly userId: string) {
    super('Login MFA challenge was presented from a different device.');
    this.name = 'LoginMfaChallengeContextMismatchError';
  }
}

export async function consumeLoginMfaChallenge(challengeToken: string, code: string, deviceIdHash?: string | null) {
  return prisma.$transaction(async (tx) => {
    const challenge = await tx.loginChallenge.findFirst({
      where: {
        challengeHash: hashToken(challengeToken),
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: { user: true },
    });
    if (!challenge || challenge.attempts >= LOGIN_MFA_MAX_ATTEMPTS) return null;

    if (challenge.deviceIdHash && challenge.deviceIdHash !== (deviceIdHash ?? null)) {
      throw new LoginMfaChallengeContextMismatchError(challenge.userId);
    }

    const matches = hashToken(code) === challenge.codeHash;
    if (!matches) {
      await tx.loginChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
      return null;
    }

    const claimed = await tx.loginChallenge.updateMany({
      where: { id: challenge.id, usedAt: null, expiresAt: { gt: new Date() }, attempts: { lt: LOGIN_MFA_MAX_ATTEMPTS } },
      data: { usedAt: new Date() },
    });
    return claimed.count === 1 ? challenge : null;
  });
}
