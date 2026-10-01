import { Prisma } from '@prisma/client';
import { buildBoundAIRequestId } from '../lib/aiSecurityGateway';
import { prisma } from '../lib/prisma';
import { estimateLiveTutorRealtimeCostUSD } from './liveTutorRealtimeCostPolicy';
import {
  estimateLiveTutorGeminiCostUSD,
  getUtcDayWindow,
  LIVE_TUTOR_IMAGE_DAILY_LIMIT,
  LIVE_TUTOR_IMAGE_RESERVATION_USD,
  type LiveTutorGeminiImageUsage,
} from './liveTutorImageAnalysisPolicy';

const LIVE_TUTOR_IMAGE_FEATURE = 'live_tutor_image';
const GEMINI_PROVIDER = 'Gemini';
const LEGACY_REALTIME_PROVIDER = 'OpenAI Realtime';
const STALE_RESERVATION_MS = 10 * 60 * 1000;

type ReservationInput = {
  userId: string;
  streamId: string;
  clientRequestId: string;
  payloadHash: string;
  mimeType: string;
  imageBytes: number;
  now?: Date;
};

type ReservationResult = {
  requestId: string;
  remaining: number;
  resetAt: Date;
  reservationStatus: string;
  providerAttemptCount: number;
  replayed: boolean;
};

export class LiveTutorImageQuotaExceededError extends Error {
  readonly resetAt: Date;

  constructor(resetAt: Date) {
    super('You have used all 5 Live Tutor image analyses for today.');
    this.name = 'LiveTutorImageQuotaExceededError';
    this.resetAt = resetAt;
  }
}

export class LiveTutorImageRequestConflictError extends Error {
  constructor(message = 'This image request ID is already bound to a different request.') {
    super(message);
    this.name = 'LiveTutorImageRequestConflictError';
  }
}

function asMetadata(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function reservationWhere(userId: string, start: Date, end: Date): Prisma.UsageLogWhereInput {
  return {
    userId,
    feature: LIVE_TUTOR_IMAGE_FEATURE,
    provider: { in: [GEMINI_PROVIDER, LEGACY_REALTIME_PROVIDER] },
    createdAt: { gte: start, lt: end },
    OR: [
      { success: true },
      { success: null },
      { providerAttemptCount: { gt: 0 } },
    ],
  };
}

export async function acquireLiveTutorImageQuotaLock(
  tx: Prisma.TransactionClient,
  userId: string,
  dayKey: string,
): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}), hashtext(${dayKey}))::text`;
}

export async function reserveLiveTutorImageAnalysis(input: ReservationInput): Promise<ReservationResult> {
  const now = input.now ?? new Date();
  const { start, end, resetAt } = getUtcDayWindow(now);
  const dayKey = start.toISOString().slice(0, 10);
  const requestId = buildBoundAIRequestId({
    userId: input.userId,
    feature: 'live_tutor',
    clientRequestId: input.clientRequestId,
    metadata: {
      operationType: 'live_tutor.image_analysis',
      payloadHash: input.payloadHash,
    },
  });

  return prisma.$transaction(async (tx) => {
    await acquireLiveTutorImageQuotaLock(tx, input.userId, dayKey);

    const existing = await tx.usageLog.findUnique({
      where: { provider_requestId: { provider: GEMINI_PROVIDER, requestId } },
    }) ?? await tx.usageLog.findUnique({
      where: { provider_requestId: { provider: LEGACY_REALTIME_PROVIDER, requestId } },
    });
    if (existing) {
      const metadata = asMetadata(existing.metadata);
      if (
        existing.userId !== input.userId
        || metadata.clientOperationId !== input.clientRequestId
        || metadata.streamId !== input.streamId
        || metadata.payloadHash !== input.payloadHash
      ) {
        throw new LiveTutorImageRequestConflictError();
      }
    }

    const staleBefore = new Date(now.getTime() - STALE_RESERVATION_MS);
    const staleReservations = await tx.usageLog.findMany({
      where: {
        userId: input.userId,
        feature: LIVE_TUTOR_IMAGE_FEATURE,
        provider: { in: [GEMINI_PROVIDER, LEGACY_REALTIME_PROVIDER] },
        success: null,
        providerAttemptCount: 0,
        createdAt: { lt: staleBefore },
      },
      select: { id: true, metadata: true },
    });
    for (const stale of staleReservations) {
      await tx.usageLog.update({
        where: { id: stale.id },
        data: {
          success: false,
          providerExposureUSD: 0,
          metadata: { ...asMetadata(stale.metadata), reservationStatus: 'expired' } as Prisma.InputJsonValue,
        },
      });
    }

    let used = await tx.usageLog.count({ where: reservationWhere(input.userId, start, end) });
    const existingMetadata = existing ? asMetadata(existing.metadata) : null;
    if (existing && existing.createdAt >= start && existing.createdAt < end) {
      const existingStatus = typeof existingMetadata?.reservationStatus === 'string' ? existingMetadata.reservationStatus : 'reserved';
      if (existingStatus !== 'released') {
        return {
          requestId,
          remaining: Math.max(0, LIVE_TUTOR_IMAGE_DAILY_LIMIT - used),
          resetAt,
          reservationStatus: existingStatus,
          providerAttemptCount: existing.providerAttemptCount,
          replayed: true,
        };
      }
    }
    if (used >= LIVE_TUTOR_IMAGE_DAILY_LIMIT) throw new LiveTutorImageQuotaExceededError(resetAt);

    const reservationMetadata = {
      clientOperationId: input.clientRequestId,
      streamId: input.streamId,
      payloadHash: input.payloadHash,
      mimeType: input.mimeType,
      imageBytes: input.imageBytes,
      reservationStatus: 'reserved',
      reservedCostUSD: LIVE_TUTOR_IMAGE_RESERVATION_USD,
      quotaDay: dayKey,
    } as Prisma.InputJsonValue;

    if (existing) {
      await tx.usageLog.update({
        where: { id: existing.id },
        data: {
          provider: GEMINI_PROVIDER,
          success: null,
          providerExposureUSD: LIVE_TUTOR_IMAGE_RESERVATION_USD,
          providerAttemptCount: 0,
          usageSource: 'UNKNOWN',
          metadata: reservationMetadata,
        },
      });
    } else {
      await tx.usageLog.create({
        data: {
          userId: input.userId,
          feature: LIVE_TUTOR_IMAGE_FEATURE,
          provider: GEMINI_PROVIDER,
          requestId,
          success: null,
          usageSource: 'UNKNOWN',
          providerCostUSD: 0,
          providerExposureUSD: LIVE_TUTOR_IMAGE_RESERVATION_USD,
          userChargeUSD: 0,
          profitUSD: -LIVE_TUTOR_IMAGE_RESERVATION_USD,
          metadata: reservationMetadata,
        },
      });
    }

    used += 1;
    return {
      requestId,
      remaining: Math.max(0, LIVE_TUTOR_IMAGE_DAILY_LIMIT - used),
      resetAt,
      reservationStatus: 'reserved',
      providerAttemptCount: 0,
      replayed: false,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export async function markLiveTutorImageProviderStarted(requestId: string, streamId: string): Promise<boolean> {
  const existing = await prisma.usageLog.findUnique({
    where: { provider_requestId: { provider: GEMINI_PROVIDER, requestId } },
  }) ?? await prisma.usageLog.findUnique({
    where: { provider_requestId: { provider: LEGACY_REALTIME_PROVIDER, requestId } },
  });
  if (!existing || existing.feature !== LIVE_TUTOR_IMAGE_FEATURE || asMetadata(existing.metadata).streamId !== streamId) return false;
  if (existing.providerAttemptCount > 0) return true;
  if (existing.success !== null) return false;

  const metadata = { ...asMetadata(existing.metadata), reservationStatus: 'provider_started' } as Prisma.InputJsonValue;
  const result = await prisma.usageLog.updateMany({
    where: { id: existing.id, success: null, providerAttemptCount: 0 },
    data: { provider: GEMINI_PROVIDER, providerAttemptCount: 1, metadata },
  });
  return result.count === 1;
}

export async function releaseLiveTutorImageReservation(requestId: string, streamId: string, reason: string): Promise<boolean> {
  const existing = await prisma.usageLog.findUnique({
    where: { provider_requestId: { provider: GEMINI_PROVIDER, requestId } },
  }) ?? await prisma.usageLog.findUnique({
    where: { provider_requestId: { provider: LEGACY_REALTIME_PROVIDER, requestId } },
  });
  if (!existing || existing.feature !== LIVE_TUTOR_IMAGE_FEATURE || asMetadata(existing.metadata).streamId !== streamId) return false;
  if (existing.providerAttemptCount > 0 || existing.success !== null) return false;

  const metadata = { ...asMetadata(existing.metadata), reservationStatus: 'released', releaseReason: reason.slice(0, 80) } as Prisma.InputJsonValue;
  const result = await prisma.usageLog.updateMany({
    where: { id: existing.id, success: null, providerAttemptCount: 0 },
    data: { success: false, providerExposureUSD: 0, userChargeUSD: 0, profitUSD: 0, metadata },
  });
  return result.count === 1;
}

export async function settleLiveTutorImageAnalysis(input: {
  requestId: string;
  streamId: string;
  outcome: 'completed' | 'provider_failed';
  usage?: (LiveTutorGeminiImageUsage & { provider: 'Gemini' }) | {
    provider: 'OpenAI Realtime';
    model: string;
    inputTokens: number;
    outputTokens: number;
    inputAudioTokens?: number;
    outputAudioTokens?: number;
  };
}): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.usageLog.findUnique({
      where: { provider_requestId: { provider: GEMINI_PROVIDER, requestId: input.requestId } },
    }) ?? await tx.usageLog.findUnique({
      where: { provider_requestId: { provider: LEGACY_REALTIME_PROVIDER, requestId: input.requestId } },
    });
    if (!existing || existing.feature !== LIVE_TUTOR_IMAGE_FEATURE || asMetadata(existing.metadata).streamId !== input.streamId) return false;
    if (existing.providerAttemptCount === 0 || existing.success !== null) return existing.success !== null;

    const actualCost = input.usage
      ? input.usage.provider === 'Gemini'
        ? estimateLiveTutorGeminiCostUSD(input.usage)
        : estimateLiveTutorRealtimeCostUSD(input.usage)
      : null;
    const settledCost = actualCost ?? existing.providerCostUSD;
    const metadata = {
      ...asMetadata(existing.metadata),
      reservationStatus: input.outcome,
      ...(input.usage?.provider === 'Gemini'
        ? { geminiUsage: input.usage, pricingBasis: 'gemini-provider-token-rates' }
        : input.usage
          ? { realtimeUsage: input.usage, pricingBasis: 'conservative-realtime-modality-rates' }
          : { usageUnavailable: true }),
    } as Prisma.InputJsonValue;
    await tx.usageLog.update({
      where: { id: existing.id },
      data: {
        success: input.outcome === 'completed',
        provider: input.usage?.provider ?? existing.provider,
        modelUsed: input.usage?.model ?? existing.modelUsed,
        tokensInput: input.usage?.inputTokens ?? existing.tokensInput,
        tokensOutput: input.usage?.outputTokens ?? existing.tokensOutput,
        tokensTotal: input.usage
          ? ('totalTokens' in input.usage && typeof input.usage.totalTokens === 'number'
            ? input.usage.totalTokens
            : input.usage.inputTokens + input.usage.outputTokens)
          : existing.tokensTotal,
        usageSource: actualCost === null ? 'UNKNOWN' : input.usage?.provider === 'Gemini' ? input.usage.source : 'ESTIMATED',
        providerCostUSD: settledCost,
        providerExposureUSD: actualCost === null ? existing.providerExposureUSD : 0,
        userChargeUSD: 0,
        profitUSD: -settledCost,
        metadata,
      },
    });
    return true;
  });
}