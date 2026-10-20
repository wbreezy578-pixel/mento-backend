import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

export const WEBSITE_IMAGE_GENERATION_MONTHLY_LIMIT = 15;
const RESERVATION_TTL_MS = 10 * 60 * 1000;

export interface WebsiteImageGenerationUsage {
  limit: number;
  generated: number;
  remaining: number;
  resetsAt: string;
}

export class WebsiteImageGenerationQuotaError extends Error {
  usage: WebsiteImageGenerationUsage;

  constructor(usage: WebsiteImageGenerationUsage) {
    super('You have used all 15 generated images for this month.');
    this.name = 'WebsiteImageGenerationQuotaError';
    this.usage = usage;
  }
}

export function getWebsiteImageGenerationMonthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function getWebsiteImageGenerationResetDate(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

function usageSnapshot(generated: number, reserved: number, now = new Date()): WebsiteImageGenerationUsage {
  return {
    limit: WEBSITE_IMAGE_GENERATION_MONTHLY_LIMIT,
    generated,
    remaining: Math.max(0, WEBSITE_IMAGE_GENERATION_MONTHLY_LIMIT - generated - reserved),
    resetsAt: getWebsiteImageGenerationResetDate(now).toISOString(),
  };
}

async function lockMonthlyQuota(tx: Prisma.TransactionClient, userId: string, monthStart: Date) {
  await tx.websiteImageGenerationQuota.upsert({
    where: { userId_monthStart: { userId, monthStart } },
    create: { userId, monthStart },
    update: {},
  });
  await tx.$queryRaw`SELECT "id" FROM "WebsiteImageGenerationQuota" WHERE "userId" = ${userId} AND "monthStart" = CAST(${monthStart} AS DATE) FOR UPDATE`;
  return tx.websiteImageGenerationQuota.findUniqueOrThrow({
    where: { userId_monthStart: { userId, monthStart } },
  });
}

async function expireStaleReservations(
  tx: Prisma.TransactionClient,
  userId: string,
  monthStart: Date,
  now: Date,
): Promise<number> {
  const expired = await tx.websiteImageGenerationReservation.findMany({
    where: { userId, monthStart, status: 'reserved', expiresAt: { lte: now } },
    select: { id: true },
  });
  if (!expired.length) return 0;
  const changed = await tx.websiteImageGenerationReservation.updateMany({
    where: { id: { in: expired.map(({ id }) => id) }, status: 'reserved' },
    data: { status: 'expired' },
  });
  if (changed.count) {
    await tx.websiteImageGenerationQuota.update({
      where: { userId_monthStart: { userId, monthStart } },
      data: { reservedImages: { decrement: changed.count } },
    });
  }
  return changed.count;
}

export async function getWebsiteImageGenerationUsage(userId: string, now = new Date()): Promise<WebsiteImageGenerationUsage> {
  const monthStart = getWebsiteImageGenerationMonthStart(now);
  return prisma.$transaction(async (tx) => {
    await lockMonthlyQuota(tx, userId, monthStart);
    await expireStaleReservations(tx, userId, monthStart, now);
    const current = await tx.websiteImageGenerationQuota.findUniqueOrThrow({
      where: { userId_monthStart: { userId, monthStart } },
    });
    return usageSnapshot(current.generatedImages, current.reservedImages, now);
  });
}

export async function reserveWebsiteImageGeneration(userId: string, now = new Date()): Promise<{
  reservationId: string;
  usage: WebsiteImageGenerationUsage;
}> {
  const monthStart = getWebsiteImageGenerationMonthStart(now);
  const outcome = await prisma.$transaction(async (tx) => {
    await lockMonthlyQuota(tx, userId, monthStart);
    await expireStaleReservations(tx, userId, monthStart, now);
    const current = await tx.websiteImageGenerationQuota.findUniqueOrThrow({
      where: { userId_monthStart: { userId, monthStart } },
    });
    if (current.generatedImages + current.reservedImages >= WEBSITE_IMAGE_GENERATION_MONTHLY_LIMIT) {
      return { kind: 'exhausted' as const, usage: usageSnapshot(current.generatedImages, current.reservedImages, now) };
    }

    const reservationId = randomUUID();
    await tx.websiteImageGenerationReservation.create({
      data: {
        id: reservationId,
        userId,
        monthStart,
        expiresAt: new Date(now.getTime() + RESERVATION_TTL_MS),
      },
    });
    const updated = await tx.websiteImageGenerationQuota.update({
      where: { userId_monthStart: { userId, monthStart } },
      data: { reservedImages: { increment: 1 } },
    });
    return {
      kind: 'reserved' as const,
      reservationId,
      usage: usageSnapshot(updated.generatedImages, updated.reservedImages, now),
    };
  });
  if (outcome.kind === 'exhausted') throw new WebsiteImageGenerationQuotaError(outcome.usage);
  return outcome;
}

export async function completeWebsiteImageGenerationReservation(
  userId: string,
  reservationId: string,
  now = new Date(),
): Promise<WebsiteImageGenerationUsage> {
  await prisma.$transaction(async (tx) => {
    const existingReservation = await tx.websiteImageGenerationReservation.findFirst({
      where: { id: reservationId, userId },
      select: { monthStart: true },
    });
    if (!existingReservation) throw new Error('Image generation reservation was not found.');
    const monthStart = existingReservation.monthStart;
    await lockMonthlyQuota(tx, userId, monthStart);
    const updatedReservation = await tx.websiteImageGenerationReservation.updateMany({
      where: { id: reservationId, userId, monthStart, status: 'reserved' },
      data: { status: 'completed', completedAt: now },
    });
    if (updatedReservation.count !== 1) throw new Error('Image generation reservation is no longer active.');
    await tx.websiteImageGenerationQuota.update({
      where: { userId_monthStart: { userId, monthStart } },
      data: { reservedImages: { decrement: 1 }, generatedImages: { increment: 1 } },
    });
  });
  return getWebsiteImageGenerationUsage(userId, now);
}

export async function releaseWebsiteImageGenerationReservation(
  userId: string,
  reservationId: string,
  now = new Date(),
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existingReservation = await tx.websiteImageGenerationReservation.findFirst({
      where: { id: reservationId, userId },
      select: { monthStart: true },
    });
    if (!existingReservation) return;
    const monthStart = existingReservation.monthStart;
    await lockMonthlyQuota(tx, userId, monthStart);
    const updatedReservation = await tx.websiteImageGenerationReservation.updateMany({
      where: { id: reservationId, userId, monthStart, status: 'reserved' },
      data: { status: 'failed', completedAt: now },
    });
    if (updatedReservation.count) {
      await tx.websiteImageGenerationQuota.update({
        where: { userId_monthStart: { userId, monthStart } },
        data: { reservedImages: { decrement: updatedReservation.count } },
      });
    }
  });
}
