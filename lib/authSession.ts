import crypto from 'node:crypto';
import { prisma } from './prisma';
import { createHash } from 'node:crypto';
import logger from './logger';

export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSessionRecord(input: {
  userId: string;
  token: string;
  userAgent?: string | null;
  ipAddress?: string | null;
  expiresAt: Date;
}) {
  return prisma.session.create({
    data: {
      userId: input.userId,
      tokenHash: hashToken(input.token),
      userAgent: input.userAgent ?? null,
      ipAddress: input.ipAddress ?? null,
      expiresAt: input.expiresAt,
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
  const passwordResetToken = await prisma.passwordResetToken.findFirst({
    where: {
      tokenHash,
      usedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    include: { user: true },
  });

  if (!passwordResetToken) {
    return null;
  }

  await prisma.passwordResetToken.update({
    where: { id: passwordResetToken.id },
    data: { usedAt: new Date(), revokedAt: new Date() },
  });

  return passwordResetToken;
}

export async function findSessionByToken(token: string) {
  const tokenHash = hashToken(token);
  const tokenFingerprint = tokenHash.slice(0, 12);
  logger.info('findSessionByToken: lookup', { tokenFingerprint });
  const session = await prisma.session.findFirst({
    where: { tokenHash, revokedAt: null },
    include: { user: true },
  });

  if (!session) {
    logger.info('findSessionByToken: no match', { tokenFingerprint });
    return null;
  }

  logger.info('findSessionByToken: matched', { sessionId: session.id, userId: session.userId, expiresAt: session.expiresAt?.toISOString(), replacedBySessionId: session.replacedBySessionId ?? null });
  return session;
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
}) {
  return prisma.$transaction(async (transaction) => {
    const claimed = await transaction.session.updateMany({
      where: {
        id: input.sessionId,
        userId: input.userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
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
      },
    });

    await transaction.session.update({
      where: { id: input.sessionId },
      data: { replacedBySessionId: replacement.id },
    });

    return replacement;
  });
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
