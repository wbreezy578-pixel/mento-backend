import { createHmac, createHash } from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { ensureUserBillingSetup } from './economicsService';
import { ensureDefaultPlans } from './planService';
import { applyVerifiedEntitlementEvent } from './entitlementService';
import logger from '../lib/logger';
import { incrementMonitoringFailure, observeMonitoringLatency } from '../lib/monitoring';
import { trackShutdownOperation } from '../lib/crashRecovery';
import { getPaddleNotificationWebhookSecret, getPaddleTopUp50PriceId, getPaddleTopUp100PriceId } from '../lib/env';
import { getPaddleInstance } from '../lib/paddle';
import '../lib/metrics';
import { getProductPolicy } from './productPolicy';

export type PaymentProvider = 'MPESA' | 'GOOGLE_PLAY' | 'APPLE_APP_STORE' | 'PADDLE';
export type PaymentType = 'SUBSCRIPTION' | 'TOP_UP';
export type PaymentStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'REQUIRES_ACTION' | 'REFUNDED';

export interface StartPaymentInput {
  userId: string;
  provider: PaymentProvider;
  type: PaymentType;
  amountUsd: number;
  currency?: string;
  description?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  providerCustomerId?: string;
  providerSubscriptionId?: string;
  providerTransactionId?: string;
}

export interface PaymentReceiptView {
  receiptNumber: string;
  status: string;
  receiptUrl?: string | null;
  documentHash?: string | null;
}

export interface PaymentTransactionView {
  id: string;
  provider: PaymentProvider;
  type: PaymentType;
  status: PaymentStatus;
  amountUsd: number;
  currency: string;
  description?: string | null;
  providerTransactionId?: string | null;
  providerSubscriptionId?: string | null;
  failureReason?: string | null;
  metadata?: Record<string, unknown> | null;
  providerPayload?: Record<string, unknown> | null;
  checkoutUrl?: string | null;
  receipt?: PaymentReceiptView | null;
  createdAt: string;
}

interface PaymentRecord {
  id: string;
  userId: string;
  provider: PaymentProvider;
  type: PaymentType;
  status: PaymentStatus;
  currency: string;
  amountUsd: number;
  amountMinor: number;
  description?: string | null;
  idempotencyKey?: string | null;
  receiptNumber?: string | null;
  providerTransactionId?: string | null;
  providerSubscriptionId?: string | null;
  providerCustomerId?: string | null;
  metadata?: Prisma.JsonValue | null;
  providerPayload?: Prisma.JsonValue | null;
  failureReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const WEBHOOK_SECRET_ENV_KEYS: Record<PaymentProvider, string> = {
  MPESA: 'PAYMENT_MPESA_WEBHOOK_SECRET',
  GOOGLE_PLAY: 'PAYMENT_GOOGLE_PLAY_WEBHOOK_SECRET',
  APPLE_APP_STORE: 'PAYMENT_APPLE_APP_STORE_WEBHOOK_SECRET',
  PADDLE: 'PADDLE_NOTIFICATION_WEBHOOK_SECRET',
};

const PROVIDER_DISPLAY_NAMES: Record<PaymentProvider, string> = {
  MPESA: 'M-Pesa',
  GOOGLE_PLAY: 'Google Play Billing',
  APPLE_APP_STORE: 'Apple App Store',
  PADDLE: 'Paddle',
};

function normalizeProvider(value: string): PaymentProvider {
  switch (value.toUpperCase()) {
    case 'MPESA': return 'MPESA';
    case 'GOOGLE_PLAY': return 'GOOGLE_PLAY';
    case 'APPLE_APP_STORE': return 'APPLE_APP_STORE';
    case 'PADDLE': return 'PADDLE';
    default: throw new Error('Unsupported payment provider');
  }
}

function validateAmount(amountUsd: number): number {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error('amountUsd must be a positive number');
  }
  return Number(amountUsd.toFixed(2));
}

function validateCurrency(value?: string): string {
  const currency = (typeof value === 'string' && value.trim()) ? value.trim().toUpperCase() : 'USD';
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error('currency must be a valid 3-letter ISO code');
  }
  return currency;
}

function validateDescription(value: string | undefined, defaultValue: string): string {
  const description = typeof value === 'string' && value.trim() ? value.trim() : defaultValue;
  return description.slice(0, 255);
}

function normalizeStatus(value: string): PaymentStatus {
  switch (value.toUpperCase()) {
    case 'PENDING': return 'PENDING';
    case 'SUCCEEDED': return 'SUCCEEDED';
    case 'FAILED': return 'FAILED';
    case 'CANCELLED': return 'CANCELLED';
    case 'REQUIRES_ACTION': return 'REQUIRES_ACTION';
    case 'REFUNDED': return 'REFUNDED';
    default: return 'PENDING';
  }
}

function createReceiptNumber(transactionId: string): string {
  const suffix = transactionId.slice(-8).toUpperCase();
  return `RCPT-${suffix}`;
}

function createDocumentHash(payload: Record<string, unknown>): string {
  const serialized = JSON.stringify(payload);
  return createHash('sha256').update(serialized).digest('hex');
}

function asJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isPrismaUniqueConstraintError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
}

export function buildPaymentIdempotencyKey(input: Pick<StartPaymentInput, 'userId' | 'provider' | 'type' | 'amountUsd' | 'currency' | 'description' | 'metadata' | 'idempotencyKey'>): string {
  const normalized = {
    userId: input.userId,
    provider: input.provider,
    type: input.type,
    amountUsd: Number(input.amountUsd).toFixed(2),
    currency: (input.currency ?? 'USD').toUpperCase(),
    description: (input.description ?? '').trim(),
    metadata: input.metadata ?? {},
  };
  return `payment:${createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}`;
}

function getWebhookSecret(provider: PaymentProvider): string {
  if (provider === 'PADDLE') {
    return getPaddleNotificationWebhookSecret()?.trim() ?? '';
  }

  return process.env[WEBHOOK_SECRET_ENV_KEYS[provider]]?.trim() ?? '';
}

/**
 * Maps Paddle product price IDs to live tutor minutes.
 * Returns the minute amount for known Paddle top-up price IDs.
 * Returns null for unknown price IDs (including Pro subscription prices).
 */
function getPaddleTopUpMinutesForPriceId(priceId: string): number | null {
  if (!priceId || typeof priceId !== 'string') {
    return null;
  }

  const priceId50 = getPaddleTopUp50PriceId();
  const priceId100 = getPaddleTopUp100PriceId();

  if (priceId === priceId50) {
    return 50;
  }
  if (priceId === priceId100) {
    return 100;
  }

  return null;
}

async function getOrCreateTransaction(input: StartPaymentInput): Promise<PaymentRecord> {
  const amountUsd = validateAmount(input.amountUsd);
  const provider = normalizeProvider(input.provider);
  const currency = validateCurrency(input.currency);
  const description = validateDescription(
    input.description,
    `${PROVIDER_DISPLAY_NAMES[provider]} ${input.type.toLowerCase()}`
  );

  const idempotencyKey = input.idempotencyKey?.trim() || buildPaymentIdempotencyKey({
    userId: input.userId,
    provider,
    type: input.type,
    amountUsd,
    currency,
    description,
    metadata: input.metadata,
  });

  if (input.providerTransactionId) {
    const existingByExternalId = await prisma.paymentTransaction.findUnique({
      where: { providerTransactionId: input.providerTransactionId },
    });
    if (existingByExternalId) {
      if (existingByExternalId.userId !== input.userId) {
        throw new Error('providerTransactionId is already associated with another user');
      }
      return existingByExternalId as PaymentRecord;
    }
  }

  const existing = await prisma.paymentTransaction.findUnique({ where: { idempotencyKey } });
  if (existing) {
    return existing as PaymentRecord;
  }

  try {
    const transaction = await prisma.paymentTransaction.create({
      data: {
        userId: input.userId,
        provider,
        type: input.type,
        status: 'PENDING',
        currency,
        amountUsd,
        amountMinor: Math.round(amountUsd * 100),
        description,
        idempotencyKey,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        providerCustomerId: input.providerCustomerId?.trim() || undefined,
        providerSubscriptionId: input.providerSubscriptionId?.trim() || undefined,
        providerTransactionId: input.providerTransactionId?.trim() || undefined,
      },
    });
    return transaction as PaymentRecord;
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      const conflictTarget = String(error.meta?.target ?? '');
      if (conflictTarget.includes('idempotencyKey')) {
        const existingRetry = await prisma.paymentTransaction.findUnique({ where: { idempotencyKey } });
        if (existingRetry) {
          return existingRetry as PaymentRecord;
        }
      }
      if (input.providerTransactionId && conflictTarget.includes('providerTransactionId')) {
        const existingRetry = await prisma.paymentTransaction.findUnique({ where: { providerTransactionId: input.providerTransactionId } });
        if (existingRetry) {
          return existingRetry as PaymentRecord;
        }
      }
    }
    throw error;
  }
}

export async function startPayment(input: StartPaymentInput): Promise<PaymentTransactionView> {
  return trackShutdownOperation(startPaymentInternal(input));
}

async function startPaymentInternal(input: StartPaymentInput): Promise<PaymentTransactionView> {
  const startedAt = Date.now();
  const provider = normalizeProvider(input.provider);

  try {
    const transaction = await getOrCreateTransaction(input);
    // For Paddle flow, the client will perform checkout via Paddle.js and provide
    // providerTransactionId/providerCustomerId back to the server when available.

    const receipt = await prisma.paymentReceipt.findUnique({ where: { transactionId: transaction.id } });
    observeMonitoringLatency('billing', Date.now() - startedAt, { provider, operation: 'start_payment' });
    return toView({
      ...transaction,
      receipt,
    } as PaymentRecord & { receipt?: { receiptNumber: string; status: string; receiptUrl: string | null; documentHash: string | null } | null });
  } catch (error) {
    observeMonitoringLatency('billing', Date.now() - startedAt, { provider, operation: 'start_payment', status: 'error' });
    incrementMonitoringFailure('payment', { provider, operation: 'start_payment' });
    logger.warn('Payment start failed', { provider, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

export async function finalizePayment(input: {
  transactionId: string;
  provider: PaymentProvider;
  status: PaymentStatus;
  providerTransactionId?: string;
  providerSubscriptionId?: string;
  providerPayload?: Record<string, unknown>;
  failureReason?: string;
  idempotencyKey?: string;
  amountMinor?: number;
  currency?: string;
}): Promise<PaymentTransactionView> {
  return trackShutdownOperation(finalizePaymentInternal(input));
}

async function finalizePaymentInternal(input: {
  transactionId: string;
  provider: PaymentProvider;
  status: PaymentStatus;
  providerTransactionId?: string;
  providerSubscriptionId?: string;
  providerPayload?: Record<string, unknown>;
  failureReason?: string;
  idempotencyKey?: string;
  amountMinor?: number;
  currency?: string;
}): Promise<PaymentTransactionView> {
  const startedAt = Date.now();
  const provider = normalizeProvider(input.provider);
  const status = normalizeStatus(input.status);

  const transaction = await prisma.paymentTransaction.findUnique({ where: { id: input.transactionId } });
  if (!transaction) {
    throw new Error('Payment transaction not found');
  }

  if (input.idempotencyKey && transaction.idempotencyKey !== input.idempotencyKey) {
    throw new Error('Idempotency key mismatch');
  }

  if (transaction.provider !== provider) {
    throw new Error('Payment provider mismatch');
  }

  if (transaction.status === 'SUCCEEDED' && status === 'SUCCEEDED') {
    return toView({
      ...transaction,
      receipt: await prisma.paymentReceipt.findUnique({ where: { transactionId: transaction.id } }),
    } as PaymentRecord & { receipt?: { receiptNumber: string; status: string; receiptUrl: string | null; documentHash: string | null } | null });
  }

  // Use longer transaction timeout to accommodate plan initialization
  const updated = await prisma.$transaction(
    async (tx) => {
      const updateData = {
        provider,
        status,
        providerTransactionId: input.providerTransactionId?.trim() || undefined,
        providerSubscriptionId: input.providerSubscriptionId?.trim() || undefined,
        providerPayload: (input.providerPayload ?? undefined) as Prisma.InputJsonValue | undefined,
        failureReason: input.failureReason?.trim() || undefined,
        amountMinor: Number.isInteger(input.amountMinor) && Number(input.amountMinor) >= 0 ? Number(input.amountMinor) : undefined,
        amountUsd: Number.isInteger(input.amountMinor) && Number(input.amountMinor) >= 0 ? Number(input.amountMinor) / 100 : undefined,
        currency: input.currency ? validateCurrency(input.currency) : undefined,
        lastWebhookAt: new Date(),
      };

      let current;
      if (status === 'SUCCEEDED') {
        const claimed = await tx.paymentTransaction.updateMany({
          where: { id: transaction.id, status: { not: 'SUCCEEDED' } },
          data: updateData,
        });
        current = await tx.paymentTransaction.findUniqueOrThrow({ where: { id: transaction.id } });
        if (claimed.count === 0) return current;
      } else {
        current = await tx.paymentTransaction.update({ where: { id: transaction.id }, data: updateData });
      }

    if (status === 'SUCCEEDED') {
      if (!current.userId) {
        throw new Error('Payment transaction is missing an associated user.');
      }

      await ensureUserBillingSetup(current.userId);
      await ensureDefaultPlans();

      if (current.type === 'SUBSCRIPTION') {
        // Phase 4C: Subscription entitlement state (plan, status, periods, entitlementUpdatedAt)
        // is now handled solely by applyVerifiedEntitlementEvent() to avoid race conditions.
        // Finalization is payment-only: it records the transaction success.
        // The provider adapter (caller) invokes applyVerifiedEntitlementEvent() with
        // verified provider state (subscription periods, status from provider API).
        // This ensures canonical entitlement authority is not split between
        // finalization and applyVerifiedEntitlementEvent().

        const liveTutorWallet = await tx.liveTutorWallet.findUnique({ where: { userId: current.userId } });
        if (liveTutorWallet) {
          const includedSeconds = getProductPolicy('PRO').liveTutor.includedSecondsPerPeriod;
          const updated = await tx.liveTutorWallet.update({ where: { userId: current.userId }, data: { minutesBalance: Math.floor((includedSeconds + liveTutorWallet.topUpSeconds) / 60), includedSeconds } });
          await tx.liveTutorMinuteLedger.create({ data: {
            userId: current.userId, walletId: updated.id, idempotencyKey: `subscription:${current.provider}:${current.id}`,
            entryType: 'SUBSCRIPTION_PERIOD_RESET', source: current.provider,
            includedSecondsAfter: updated.includedSeconds, topUpSecondsAfter: updated.topUpSeconds,
          } });
          logger.info('Reset included Live Tutor allowance for completed Pro transaction', { userId: current.userId, transactionId: current.id, includedSeconds });
        }
      }

      if (current.type === 'TOP_UP') {
        // Fix 2: Map Paddle top-up price IDs to exact minute amounts
        let topUpMinutes: number | null = null;
        
        // First try to get price ID from provider payload (Paddle includes this)
        const providerPayload = asJsonObject(current.providerPayload);
        const providerData = asJsonObject(providerPayload.data);
        const items = Array.isArray(providerData.items) ? providerData.items : Array.isArray(providerPayload.items) ? providerPayload.items : [];
        const firstItem = asJsonObject(items[0]);
        const price = asJsonObject(firstItem.price);
        const metadata = asJsonObject(current.metadata);
        const paddlePriceId = String(price.id ?? metadata.priceId ?? '').trim();
        
        if (paddlePriceId) {
          topUpMinutes = getPaddleTopUpMinutesForPriceId(paddlePriceId);
          if (topUpMinutes === null) {
            // Unknown Paddle price ID for top-up - log and do not grant minutes
            logger.warn('Received top-up payment with unknown Paddle price ID', {
              userId: current.userId,
              priceId: paddlePriceId,
              transactionId: current.id,
            });
            topUpMinutes = 0; // Explicitly set to 0 to indicate no grant
          } else {
            logger.info('Mapped Paddle price ID to top-up minutes', {
              userId: current.userId,
              priceId: paddlePriceId,
              minutes: topUpMinutes,
              transactionId: current.id,
            });
          }
        } else if (provider !== 'PADDLE') {
          const configuredMinutes = Number(metadata.topUpMinutes);
          if (!Number.isSafeInteger(configuredMinutes) || configuredMinutes <= 0) {
            throw new Error('Verified native-store top-up is missing a valid minute grant.');
          }
          topUpMinutes = configuredMinutes;
        } else {
          throw new Error('Completed Paddle top-up did not contain a recognized price ID.');
        }

        // Only grant minutes if we have a positive amount
        if (topUpMinutes && topUpMinutes > 0) {
          const wallet = await tx.liveTutorWallet.findUnique({ where: { userId: current.userId } });
          if (wallet) {
            const updated = await tx.liveTutorWallet.update({
              where: { userId: current.userId },
              data: { minutesBalance: { increment: topUpMinutes }, topUpSeconds: { increment: topUpMinutes * 60 } },
            });
            await tx.liveTutorMinuteLedger.create({ data: {
              userId: current.userId, walletId: updated.id, idempotencyKey: `topup:${current.provider}:${current.id}`,
              entryType: 'TOP_UP_CREDIT', source: current.provider, topUpSecondsDelta: topUpMinutes * 60,
              includedSecondsAfter: updated.includedSeconds, topUpSecondsAfter: updated.topUpSeconds,
              expiresAt: null,
            } });
            logger.info('Granted live tutor minutes from top-up', {
              userId: current.userId,
              minutes: topUpMinutes,
              transactionId: current.id,
            });
          }
        }
      }

      const previousEntry = await tx.paymentLedgerEntry.findFirst({
        where: { userId: current.userId },
        orderBy: { createdAt: 'desc' },
      });
      const balanceAfter = (previousEntry?.balanceAfter ?? 0) + current.amountUsd;

      await tx.paymentLedgerEntry.create({
        data: {
          userId: current.userId,
          transactionId: current.id,
          entryType: current.type === 'TOP_UP' ? 'TOP_UP' : 'SUBSCRIPTION_PAYMENT',
          amountUsd: current.amountUsd,
          amountMinor: current.amountMinor,
          currency: current.currency,
          balanceAfter,
          referenceType: current.type,
          referenceId: current.id,
          description: current.type === 'TOP_UP'
            ? `Tutor time top-up applied via ${PROVIDER_DISPLAY_NAMES[provider]}`
            : `Pro subscription payment received via ${PROVIDER_DISPLAY_NAMES[provider]}`,
          metadata: {
            provider: current.provider,
            providerTransactionId: current.providerTransactionId,
            providerSubscriptionId: current.providerSubscriptionId,
          } as Prisma.InputJsonValue,
        },
      });

      const receiptNumber = createReceiptNumber(current.id);
      await tx.paymentReceipt.upsert({
        where: { transactionId: current.id },
        create: {
          transactionId: current.id,
          userId: current.userId,
          receiptNumber,
          status: 'ISSUED',
          receiptUrl: null,
          payload: {
            amountUsd: current.amountUsd,
            provider,
            type: current.type,
            providerTransactionId: current.providerTransactionId,
          },
          documentHash: createDocumentHash({
            transactionId: current.id,
            amountUsd: current.amountUsd,
            provider,
            type: current.type,
          }),
        },
        update: {
          status: 'ISSUED',
          receiptUrl: null,
          payload: {
            amountUsd: current.amountUsd,
            provider,
            type: current.type,
            providerTransactionId: current.providerTransactionId,
          },
        },
      });

      await tx.paymentTransaction.update({
        where: { id: current.id },
        data: { receiptNumber },
      });
    }

    return current;
  },
  { timeout: 30000 }  // Increase timeout to 30 seconds for payment finalization
  );

  try {
    const view = toView({
      ...updated,
      receipt: await prisma.paymentReceipt.findUnique({ where: { transactionId: updated.id } }),
    } as PaymentRecord & { receipt?: { receiptNumber: string; status: string; receiptUrl: string | null; documentHash: string | null } | null });
    observeMonitoringLatency('billing', Date.now() - startedAt, { provider, operation: 'finalize_payment' });
    if (status === 'FAILED' || status === 'CANCELLED' || status === 'REFUNDED') {
      incrementMonitoringFailure('payment', { provider, operation: 'finalize_payment', status });
    }
    return view;
  } catch (error) {
    observeMonitoringLatency('billing', Date.now() - startedAt, { provider, operation: 'finalize_payment', status: 'error' });
    incrementMonitoringFailure('payment', { provider, operation: 'finalize_payment' });
    logger.warn('Payment finalize failed', { provider, transactionId: input.transactionId, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

export async function recoverActivePaymentTransactions(): Promise<void> {
  const pending = await prisma.paymentTransaction.findMany({
    where: { status: { in: ['PENDING', 'REQUIRES_ACTION'] } },
    select: { id: true, provider: true },
  });

  if (pending.length > 0) {
    logger.warn('Active payment transactions left recoverable during shutdown', {
      count: pending.length,
      transactionIds: pending.map((transaction) => transaction.id),
      providers: [...new Set(pending.map((transaction) => transaction.provider))],
    });
  }
}

export async function listPayments(userId: string): Promise<PaymentTransactionView[]> {
  const rows = await prisma.paymentTransaction.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: { receipt: true },
  });

  return rows.map((row) => toView(row as PaymentRecord & { receipt?: { receiptNumber: string; status: string; receiptUrl: string | null; documentHash: string | null } | null }));
}

export async function getPayment(userId: string, paymentId: string): Promise<PaymentTransactionView | null> {
  const row = await prisma.paymentTransaction.findFirst({
    where: { id: paymentId, userId },
    include: { receipt: true },
  });
  if (!row) {
    return null;
  }

  return toView(row as PaymentRecord & { receipt?: { receiptNumber: string; status: string; receiptUrl: string | null; documentHash: string | null } | null });
}

function toView(row: PaymentRecord & { receipt?: { receiptNumber: string; status: string; receiptUrl: string | null; documentHash: string | null } | null }): PaymentTransactionView {
  const providerPayload = row.providerPayload && typeof row.providerPayload === 'object'
    ? row.providerPayload as Record<string, unknown>
    : null;

  return {
    id: row.id,
    provider: row.provider,
    type: row.type,
    status: row.status,
    amountUsd: row.amountUsd,
    currency: row.currency,
    description: row.description,
    providerTransactionId: row.providerTransactionId ?? null,
    providerSubscriptionId: row.providerSubscriptionId ?? null,
    failureReason: row.failureReason ?? null,
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata as Record<string, unknown> : null,
    providerPayload,
    checkoutUrl: providerPayload && typeof providerPayload.url === 'string' ? String(providerPayload.url) : null,
    receipt: row.receipt ? {
      receiptNumber: row.receipt.receiptNumber,
      status: row.receipt.status,
      receiptUrl: row.receipt.receiptUrl,
      documentHash: row.receipt.documentHash,
    } : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function refundPaymentByProviderTransaction(
  providerTransactionId: string,
  providerPayload: Record<string, unknown>,
  options?: { adjustmentId?: string; amountMinor?: number; full?: boolean },
): Promise<boolean> {
  const existing = await prisma.paymentTransaction.findUnique({ where: { providerTransactionId } });
  if (!existing || !existing.userId) return false;

  const refundSuccess = await prisma.$transaction(async (tx) => {
    const fullRefund = options?.full !== false;
    const amountMinor = Math.min(existing.amountMinor, Math.max(0, options?.amountMinor ?? existing.amountMinor));
    if (amountMinor === 0) return false;
    const entryType = `REFUND:${options?.adjustmentId || 'full'}`;

    if (fullRefund) {
      const claimed = await tx.paymentTransaction.updateMany({
        where: { id: existing.id, status: 'SUCCEEDED' },
        data: { status: 'REFUNDED', providerPayload: providerPayload as Prisma.InputJsonValue, lastWebhookAt: new Date() },
      });
      if (claimed.count === 0) return false;
    } else {
      const duplicate = await tx.paymentLedgerEntry.findFirst({ where: { transactionId: existing.id, entryType } });
      if (duplicate) return false;
    }

    const metadata = asJsonObject(existing.metadata);
    let minutesToRevoke = 0;
    if (fullRefund && existing.type === 'SUBSCRIPTION') {
      minutesToRevoke = Math.ceil(getProductPolicy('PRO').liveTutor.includedSecondsPerPeriod / 60);
      // Phase 4C: Subscription refund entitlement state (plan downgrade, status revocation)
      // is now handled by applyVerifiedEntitlementEvent() after this transaction succeeds.
      // Finalization is payment-only: it records the refund in payment ledger and updates receipt.
    } else if (fullRefund && metadata.sku === 'topup_50') {
      minutesToRevoke = 50;
    } else if (fullRefund && metadata.sku === 'topup_100') {
      minutesToRevoke = 100;
    }

    if (minutesToRevoke > 0) {
      const wallet = await tx.liveTutorWallet.findUnique({ where: { userId: existing.userId! } });
      if (wallet) {
        await tx.liveTutorWallet.update({
          where: { userId: existing.userId! },
          data: fullRefund && existing.type === 'SUBSCRIPTION'
            ? { minutesBalance: Math.max(0, wallet.minutesBalance - minutesToRevoke), includedSeconds: 0 }
            : { minutesBalance: Math.max(0, wallet.minutesBalance - minutesToRevoke), topUpSeconds: Math.max(0, wallet.topUpSeconds - minutesToRevoke * 60) },
        });
      }
    }

    const previousEntry = await tx.paymentLedgerEntry.findFirst({ where: { userId: existing.userId }, orderBy: { createdAt: 'desc' } });
    await tx.paymentLedgerEntry.create({
      data: {
        userId: existing.userId,
        transactionId: existing.id,
        entryType,
        amountUsd: -(amountMinor / 100),
        amountMinor: -amountMinor,
        currency: existing.currency,
        balanceAfter: (previousEntry?.balanceAfter ?? 0) - amountMinor / 100,
        referenceType: 'REFUND',
        referenceId: existing.id,
        description: 'Paddle refund applied',
        metadata: { providerTransactionId, adjustmentId: options?.adjustmentId, fullRefund } as Prisma.InputJsonValue,
      },
    });
    await tx.paymentReceipt.updateMany({ where: { transactionId: existing.id }, data: { status: fullRefund ? 'REFUNDED' : 'PARTIALLY_REFUNDED' } });
    return true;
  });

  // Phase 4C: Route subscription refund through canonical entitlement boundary
  if (refundSuccess && options?.full !== false && existing.type === 'SUBSCRIPTION' && existing.providerTransactionId) {
    await applyVerifiedEntitlementEvent({
      userId: existing.userId,
      provider: 'PADDLE',
      externalEventId: `${existing.providerTransactionId}:refund:${options?.adjustmentId || 'full'}`,
      externalTransactionId: existing.providerTransactionId,
      eventType: 'subscription_refund',
      plan: 'FREE',
      status: 'REVOKED',
      periodStart: null,
      periodEnd: null,
      occurredAt: new Date(),
    });
  }

  return refundSuccess;
}

export async function verifyWebhookSignature(input: { payload: string; signature: string; provider: PaymentProvider }): Promise<boolean> {
  const provider = normalizeProvider(input.provider);
  const secret = getWebhookSecret(provider);
  if (!secret) {
    return false;
  }

  const candidate = input.signature.trim();
  if (!candidate) {
    return false;
  }

  try {
    if (provider === 'PADDLE') {
      const paddle = getPaddleInstance();
      await paddle.webhooks.unmarshal(input.payload, secret, candidate);
      return true;
    }

    const expected = createHmac('sha256', secret).update(input.payload).digest('hex');
    return candidate === expected || candidate === `sha256=${expected}`;
  } catch (err) {
    logger.warn('Webhook signature verification error', { provider, err });
    return false;
  }
}

export async function getLedgerSummary(userId: string): Promise<{ balanceUsd: number; entries: Array<{ id: string; description: string; amountUsd: number; balanceAfter: number; createdAt: string }> }> {
  const [entries, totals] = await Promise.all([
    prisma.paymentLedgerEntry.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.paymentLedgerEntry.aggregate({ where: { userId }, _sum: { amountMinor: true } }),
  ]);

  const mapped = entries.map((entry) => ({
    id: entry.id,
    description: entry.description,
    amountUsd: entry.amountUsd,
    balanceAfter: entry.balanceAfter,
    createdAt: entry.createdAt.toISOString(),
  }));

  const balanceUsd = (totals._sum.amountMinor ?? 0) / 100;
  return { balanceUsd, entries: mapped };
}
