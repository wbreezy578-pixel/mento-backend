import { getPaddleNotificationWebhookSecret } from '../lib/env';
import { getPaddleInstance } from '../lib/paddle';
import { prisma } from '../lib/prisma';
import logger from '../lib/logger';
import { finalizePayment, refundPaymentByProviderTransaction } from './paymentService';

// Paddle SDK event entities vary by event type and are normalized at runtime below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>;
type PaddleBillingEvent = {
  eventId: string;
  notificationId?: string | null;
  eventType: string;
  occurredAt: string;
  data: JsonObject;
};

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' ? value as JsonObject : {};
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function customData(data: JsonObject): JsonObject {
  return asObject(data.customData ?? data.custom_data);
}

function transactionPriceId(data: JsonObject): string {
  const items = Array.isArray(data.items) ? data.items : [];
  return firstString(items[0]?.price?.id, items[0]?.price_id);
}

function transactionAmountMinor(data: JsonObject): number {
  const totals = asObject(asObject(data.details).totals);
  const raw = firstString(totals.grandTotal, totals.grand_total, totals.total);
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Paddle transaction is missing valid authoritative totals.');
  return value;
}

async function assertPaddleOwnership(userId: string, customerId: string, subscriptionId: string): Promise<void> {
  const conflicting = await prisma.userWallet.findFirst({
    where: {
      userId: { not: userId },
      OR: [
        ...(customerId ? [{ paddleCustomerId: customerId }] : []),
        ...(subscriptionId ? [{ paddleSubscriptionId: subscriptionId }] : []),
      ],
    },
  });
  if (conflicting) throw new Error('Paddle customer or subscription is already owned by another Mento user.');
}

async function findWalletForEvent(data: JsonObject, meta: JsonObject) {
  const userId = firstString(meta.mentoUserId, meta.mento_user_id);
  if (userId) return prisma.userWallet.findUnique({ where: { userId } });
  const subscriptionId = firstString(data.subscriptionId, data.subscription_id, data.id?.startsWith?.('sub_') ? data.id : '');
  if (subscriptionId) {
    const wallet = await prisma.userWallet.findFirst({ where: { paddleSubscriptionId: subscriptionId } });
    if (wallet) return wallet;
  }
  const customerId = firstString(data.customerId, data.customer_id);
  return customerId ? prisma.userWallet.findFirst({ where: { paddleCustomerId: customerId } }) : null;
}

async function ensureLocalTransaction(data: JsonObject) {
  const meta = customData(data);
  const internalId = firstString(meta.mentoTransactionId, meta.mento_transaction_id);
  const providerTransactionId = firstString(data.id);
  let payment = internalId ? await prisma.paymentTransaction.findUnique({ where: { id: internalId } }) : null;
  if (!payment && providerTransactionId) {
    payment = await prisma.paymentTransaction.findUnique({ where: { providerTransactionId } });
  }
  if (payment) {
    if (payment.providerTransactionId && payment.providerTransactionId !== providerTransactionId) {
      throw new Error('Paddle transaction mapping conflict.');
    }
    if (firstString(meta.mentoUserId, meta.mento_user_id) && payment.userId !== firstString(meta.mentoUserId, meta.mento_user_id)) {
      throw new Error('Paddle transaction ownership conflict.');
    }
    return payment;
  }

  const wallet = await findWalletForEvent(data, meta);
  const userId = firstString(meta.mentoUserId, meta.mento_user_id, wallet?.userId);
  if (!userId || !providerTransactionId) throw new Error('Unable to map completed Paddle transaction to a Mento user.');
  const priceId = transactionPriceId(data);
  const sku = firstString(meta.sku);
  const type = data.subscriptionId || data.subscription_id || sku === 'pro' ? 'SUBSCRIPTION' : 'TOP_UP';
  const amountMinor = transactionAmountMinor(data);
  const currency = firstString(data.currencyCode, data.currency_code, 'USD').toUpperCase();

  try {
    return await prisma.paymentTransaction.create({
      data: {
        userId,
        provider: 'PADDLE',
        type,
        status: 'PENDING',
        amountMinor,
        amountUsd: amountMinor / 100,
        currency,
        description: type === 'SUBSCRIPTION' ? 'Paddle subscription renewal' : 'Paddle tutor top-up',
        idempotencyKey: `paddle-transaction:${providerTransactionId}`,
        providerTransactionId,
        providerCustomerId: firstString(data.customerId, data.customer_id) || undefined,
        providerSubscriptionId: firstString(data.subscriptionId, data.subscription_id) || undefined,
        metadata: { sku, priceId, source: 'paddle_webhook' },
      },
    });
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
      const raced = await prisma.paymentTransaction.findUnique({ where: { providerTransactionId } });
      if (raced) return raced;
    }
    throw error;
  }
}

async function processCompletedTransaction(event: PaddleBillingEvent, rawEvent: JsonObject): Promise<string> {
  const data = asObject(event.data);
  const payment = await ensureLocalTransaction(data);
  const amountMinor = transactionAmountMinor(data);
  const currency = firstString(data.currencyCode, data.currency_code, payment.currency).toUpperCase();
  const subscriptionId = firstString(data.subscriptionId, data.subscription_id);
  const customerId = firstString(data.customerId, data.customer_id);
  const priceId = transactionPriceId(data);

  await finalizePayment({
    transactionId: payment.id,
    provider: 'PADDLE',
    status: 'SUCCEEDED',
    providerTransactionId: firstString(data.id),
    providerSubscriptionId: subscriptionId || undefined,
    providerPayload: rawEvent,
    idempotencyKey: payment.idempotencyKey ?? undefined,
    amountMinor,
    currency,
  });

  if (payment.userId) {
    await assertPaddleOwnership(payment.userId, customerId, subscriptionId);
    await prisma.userWallet.update({
      where: { userId: payment.userId },
      data: {
        paddleCustomerId: customerId || undefined,
        paddleSubscriptionId: subscriptionId || undefined,
        paddlePriceId: priceId || undefined,
      },
    });
  }
  return payment.id;
}

async function processSubscriptionEvent(event: PaddleBillingEvent): Promise<void> {
  const data = asObject(event.data);
  const meta = customData(data);
  const wallet = await findWalletForEvent(data, meta);
  if (!wallet) throw new Error('Unable to map Paddle subscription event to a Mento wallet.');
  const occurredAt = new Date(event.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) throw new Error('Paddle event occurred_at is invalid.');

  const billingPeriod = asObject(data.currentBillingPeriod ?? data.current_billing_period);
  const periodEndRaw = firstString(billingPeriod.endsAt, billingPeriod.ends_at);
  const status = firstString(data.status).toLowerCase();
  const activeStatus = status === 'active' || status === 'trialing' ? status : status || 'inactive';
  const items = Array.isArray(data.items) ? data.items : [];
  const priceId = firstString(items[0]?.price?.id, items[0]?.price_id);
  await assertPaddleOwnership(
    wallet.userId,
    firstString(data.customerId, data.customer_id),
    firstString(data.id),
  );

  await prisma.userWallet.updateMany({
    where: {
      userId: wallet.userId,
      OR: [{ paddleLastEventAt: null }, { paddleLastEventAt: { lt: occurredAt } }],
    },
    data: {
      paddleCustomerId: firstString(data.customerId, data.customer_id) || undefined,
      paddleSubscriptionId: firstString(data.id) || undefined,
      paddlePriceId: priceId || undefined,
      subscriptionStatus: activeStatus,
      subscriptionExpiresAt: periodEndRaw ? new Date(periodEndRaw) : status === 'canceled' ? occurredAt : undefined,
      paddleLastEventAt: occurredAt,
    },
  });
}

async function processEvent(event: PaddleBillingEvent, rawEvent: JsonObject): Promise<string | null> {
  switch (event.eventType) {
    case 'transaction.completed':
      return processCompletedTransaction(event, rawEvent);
    case 'transaction.payment_failed': {
      const data = asObject(event.data);
      const payment = await ensureLocalTransaction(data);
      await finalizePayment({
        transactionId: payment.id,
        provider: 'PADDLE',
        status: 'FAILED',
        providerTransactionId: firstString(data.id),
        providerPayload: rawEvent,
        failureReason: 'Paddle reported that payment collection failed.',
      });
      return payment.id;
    }
    case 'subscription.created':
    case 'subscription.activated':
    case 'subscription.updated':
    case 'subscription.trialing':
    case 'subscription.past_due':
    case 'subscription.paused':
    case 'subscription.resumed':
    case 'subscription.canceled':
      await processSubscriptionEvent(event);
      return null;
    case 'adjustment.updated': {
      const data = asObject(event.data);
      const action = firstString(data.action);
      if (firstString(data.status) === 'approved' && (action === 'refund' || action === 'chargeback')) {
        const totals = asObject(data.totals);
        const amountMinor = Number.parseInt(firstString(totals.total), 10);
        await refundPaymentByProviderTransaction(
          firstString(data.transactionId, data.transaction_id),
          rawEvent,
          {
            adjustmentId: firstString(data.id, event.eventId),
            amountMinor: Number.isSafeInteger(amountMinor) ? amountMinor : undefined,
            full: firstString(data.type) === 'full',
          },
        );
      }
      return null;
    }
    default:
      logger.info('Ignoring non-entitlement Paddle event', { eventType: event.eventType, eventId: event.eventId });
      return null;
  }
}

export async function processPaddleWebhook(rawPayload: string, signature: string) {
  const secret = getPaddleNotificationWebhookSecret();
  if (!secret) throw new Error('Paddle webhook secret not configured');
  if (!signature.trim()) throw new Error('Paddle-Signature header is required');

  let event: PaddleBillingEvent;
  try {
    event = await getPaddleInstance().webhooks.unmarshal(rawPayload, secret, signature) as PaddleBillingEvent;
  } catch (error) {
    logger.warn('Paddle webhook signature verification failed', { error: error instanceof Error ? error.message : String(error) });
    throw new Error('Invalid Paddle webhook signature');
  }

  const rawEvent = asObject(JSON.parse(rawPayload));
  if (!event.eventId || !event.eventType || !event.occurredAt) throw new Error('Invalid Paddle Billing event envelope');
  const occurredAt = new Date(event.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) throw new Error('Invalid Paddle event timestamp');

  let inbox;
  try {
    inbox = await prisma.paymentWebhookEvent.create({
      data: {
        provider: 'PADDLE',
        eventId: event.eventId,
        notificationId: event.notificationId ?? undefined,
        eventType: event.eventType,
        occurredAt,
        rawPayload,
        status: 'PROCESSING',
        attempts: 1,
      },
    });
  } catch (error) {
    if (!(typeof error === 'object' && error && 'code' in error && error.code === 'P2002')) throw error;
    const existing = await prisma.paymentWebhookEvent.findUnique({ where: { provider_eventId: { provider: 'PADDLE', eventId: event.eventId } } });
    if (existing?.status === 'PROCESSED' || existing?.status === 'PROCESSING') return { ok: true, duplicate: true };
    if (!existing) throw error;
    const claimed = await prisma.paymentWebhookEvent.updateMany({
      where: { id: existing.id, status: 'FAILED' },
      data: { status: 'PROCESSING', attempts: { increment: 1 }, error: null },
    });
    if (claimed.count === 0) return { ok: true, duplicate: true };
    inbox = await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { id: existing.id } });
  }

  try {
    const transactionId = await processEvent(event, rawEvent);
    await prisma.paymentWebhookEvent.update({
      where: { id: inbox.id },
      data: { status: 'PROCESSED', processedAt: new Date(), transactionId, error: null },
    });
    return { ok: true, duplicate: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.paymentWebhookEvent.update({ where: { id: inbox.id }, data: { status: 'FAILED', error: message.slice(0, 1000) } }).catch(() => undefined);
    throw error;
  }
}

const paddleWebhookService = { processPaddleWebhook };
export default paddleWebhookService;
