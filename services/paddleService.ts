import { randomUUID } from 'crypto';
import { prisma } from '../lib/prisma';
import { getPaddleInstance } from '../lib/paddle';
import {
  getPaddleEnv,
  getPaddleCheckoutUrl,
  getPaddleProPriceId,
  getPaddleTopUp50PriceId,
  getPaddleTopUp100PriceId,
} from '../lib/env';
import { finalizePayment, startPayment } from './paymentService';
import { getCircuitBreaker } from '../lib/resilience';
import logger from '../lib/logger';
import { isIdempotentProviderCancellationError } from './accountDeletionPolicy';

const paddleBreaker = getCircuitBreaker('payment:paddle', 3, 60_000);

export type PaddleCheckoutSku = 'pro' | 'topup_50' | 'topup_100';

const CHECKOUT_PRODUCTS: Record<PaddleCheckoutSku, {
  type: 'SUBSCRIPTION' | 'TOP_UP';
  amountUsd: number;
  priceId: () => string;
  description: string;
}> = {
  pro: { type: 'SUBSCRIPTION', amountUsd: 29, priceId: getPaddleProPriceId, description: 'Mento Pro subscription checkout' },
  topup_50: { type: 'TOP_UP', amountUsd: 10, priceId: getPaddleTopUp50PriceId, description: 'Mento 50-minute tutor top-up' },
  topup_100: { type: 'TOP_UP', amountUsd: 20, priceId: getPaddleTopUp100PriceId, description: 'Mento 100-minute tutor top-up' },
};

export interface PaddleCheckoutInitialization {
  checkoutUrl: string;
  transactionId: string;
  paddleTransactionId: string;
  environment: 'sandbox' | 'production';
  plan: PaddleCheckoutSku;
}

export function isPaddleCheckoutSku(value: string): value is PaddleCheckoutSku {
  return Object.prototype.hasOwnProperty.call(CHECKOUT_PRODUCTS, value);
}

export async function createPaddleCheckoutForUser(userId: string, sku: PaddleCheckoutSku): Promise<PaddleCheckoutInitialization> {
  const product = CHECKOUT_PRODUCTS[sku];
  const priceId = product.priceId();
  const checkoutAttemptId = randomUUID();
  if (paddleBreaker.isOpen()) {
    throw new Error('Paddle checkout is temporarily unavailable. Please try again shortly.');
  }
  const localPayment = await startPayment({
    userId,
    provider: 'PADDLE',
    type: product.type,
    amountUsd: product.amountUsd,
    currency: 'USD',
    description: product.description,
    idempotencyKey: `paddle-checkout:${checkoutAttemptId}`,
    metadata: { sku, priceId, checkoutAttemptId },
  });

  const wallet = await prisma.userWallet.findUnique({ where: { userId } });
  let transaction;
  try {
    transaction = await getPaddleInstance().transactions.create({
      items: [{ priceId, quantity: 1 }],
      collectionMode: 'automatic',
      customerId: wallet?.paddleCustomerId ?? undefined,
      customData: { mentoTransactionId: localPayment.id, mentoUserId: userId, sku, checkoutAttemptId },
      checkout: { url: getPaddleCheckoutUrl() },
    });
    paddleBreaker.recordSuccess();
  } catch (error) {
    paddleBreaker.recordFailure();
    await prisma.paymentTransaction.update({
      where: { id: localPayment.id },
      data: { status: 'FAILED', failureReason: error instanceof Error ? error.message.slice(0, 500) : 'Paddle checkout creation failed' },
    }).catch(() => undefined);
    throw error;
  }

  try {
    const checkoutUrl = transaction.checkout?.url;
    if (!checkoutUrl) {
      throw new Error('Paddle did not return a checkout URL. Configure the default payment link in Paddle.');
    }

    await prisma.paymentTransaction.update({
      where: { id: localPayment.id },
      data: {
        providerTransactionId: transaction.id,
        providerCustomerId: transaction.customerId ?? undefined,
        providerPayload: { paddleTransactionId: transaction.id, checkoutUrl, checkoutAttemptId },
      },
    });

    return { checkoutUrl, transactionId: localPayment.id, paddleTransactionId: transaction.id, environment: getPaddleEnv(), plan: sku };
  } catch (error) {
    await prisma.paymentTransaction.update({
      where: { id: localPayment.id },
      data: { status: 'FAILED', failureReason: error instanceof Error ? error.message.slice(0, 500) : 'Paddle checkout creation failed' },
    }).catch(() => undefined);
    throw error;
  }
}

export async function createProCheckoutForUser(userId: string): Promise<PaddleCheckoutInitialization> {
  return createPaddleCheckoutForUser(userId, 'pro');
}

export async function createPaddleCustomerPortalForUser(userId: string): Promise<string> {
  const wallet = await prisma.userWallet.findUnique({ where: { userId } });
  if (!wallet?.paddleCustomerId) {
    throw new Error('No Paddle customer is associated with this account.');
  }
  if (paddleBreaker.isOpen()) throw new Error('Paddle subscription management is temporarily unavailable.');
  try {
    const session = await getPaddleInstance().customerPortalSessions.create(
      wallet.paddleCustomerId,
      wallet.paddleSubscriptionId ? [wallet.paddleSubscriptionId] : [],
    );
    paddleBreaker.recordSuccess();
    return session.urls.general.overview;
  } catch (error) {
    paddleBreaker.recordFailure();
    throw error;
  }
}

export async function cancelPaddleSubscriptionForAccountDeletion(subscriptionId: string): Promise<void> {
  if (!subscriptionId.trim()) return;
  if (paddleBreaker.isOpen()) {
    throw new Error('Paddle subscription cancellation is temporarily unavailable. Please try account deletion again shortly.');
  }

  try {
    const subscription = await getPaddleInstance().subscriptions.get(subscriptionId);
    if (subscription.status !== 'canceled') {
      await getPaddleInstance().subscriptions.cancel(subscriptionId, { effectiveFrom: 'immediately' });
    }
    paddleBreaker.recordSuccess();
  } catch (error) {
    if (isIdempotentProviderCancellationError(error)) {
      paddleBreaker.recordSuccess();
      return;
    }
    paddleBreaker.recordFailure();
    logger.error('Paddle cancellation before account deletion failed', { errorName: error instanceof Error ? error.name : 'unknown' });
    throw new Error('We could not cancel your active subscription. Your account was not deleted; please try again or contact support.', { cause: error });
  }
}

export async function reconcilePendingPaddleTransactions(): Promise<void> {
  if (paddleBreaker.isOpen()) return;
  const pending = await prisma.paymentTransaction.findMany({
    where: {
      provider: 'PADDLE',
      status: { in: ['PENDING', 'REQUIRES_ACTION'] },
      providerTransactionId: { not: null },
      updatedAt: { lt: new Date(Date.now() - 2 * 60_000) },
    },
    orderBy: { updatedAt: 'asc' },
    take: 50,
  });

  for (const payment of pending) {
    if (!payment.providerTransactionId) continue;
    let transaction;
    try {
      transaction = await getPaddleInstance().transactions.get(payment.providerTransactionId);
      paddleBreaker.recordSuccess();
    } catch {
      paddleBreaker.recordFailure();
      if (paddleBreaker.isOpen()) break;
      continue;
    }

    try {
      if (transaction.status === 'completed') {
        const rawTotal = transaction.details?.totals?.grandTotal ?? transaction.details?.totals?.total;
        const amountMinor = Number.parseInt(String(rawTotal ?? ''), 10);
        if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) continue;
        await finalizePayment({
          transactionId: payment.id,
          provider: 'PADDLE',
          status: 'SUCCEEDED',
          providerTransactionId: transaction.id,
          providerSubscriptionId: transaction.subscriptionId ?? undefined,
          providerPayload: { source: 'paddle_reconciliation', transactionId: transaction.id },
          idempotencyKey: payment.idempotencyKey ?? undefined,
          amountMinor,
          currency: transaction.currencyCode,
        });
        if (payment.userId) {
          await prisma.userWallet.update({
            where: { userId: payment.userId },
            data: {
              paddleCustomerId: transaction.customerId ?? undefined,
              paddleSubscriptionId: transaction.subscriptionId ?? undefined,
              paddlePriceId: transaction.items[0]?.price?.id ?? undefined,
            },
          });
        }
      } else if (transaction.status === 'past_due' || transaction.status === 'canceled') {
        await finalizePayment({
          transactionId: payment.id,
          provider: 'PADDLE',
          status: transaction.status === 'canceled' ? 'CANCELLED' : 'FAILED',
          providerTransactionId: transaction.id,
          providerPayload: { source: 'paddle_reconciliation', transactionId: transaction.id },
          failureReason: `Paddle transaction is ${transaction.status}.`,
        });
      }
    } catch (error) {
      logger.warn('Failed to reconcile a Paddle transaction', { paymentId: payment.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

const paddleService = { createPaddleCheckoutForUser, createProCheckoutForUser, createPaddleCustomerPortalForUser, reconcilePendingPaddleTransactions };
export default paddleService;
