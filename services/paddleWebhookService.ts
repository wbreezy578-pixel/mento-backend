import { getPaddleInstance } from '../lib/paddle';
import { getPaddleNotificationWebhookSecret } from '../lib/env';
import { prisma } from '../lib/prisma';
import { finalizePayment } from './paymentService';
import { getProPlan } from './planService';
import logger from '../lib/logger';

export interface ParsedPaddleEvent {
  alert_name?: string;
  alert_id?: string | number;
  passthrough?: string;
  subscription_id?: string;
  checkout_id?: string;
  sale_id?: string;
  customer_id?: string;
  product_id?: string;
  [key: string]: any;
}

async function assertPaddleOwnership(db: typeof prisma, expectedUserId: string | null | undefined, customerId?: string, subscriptionId?: string, alertName?: string) {
  const checks = [
    { field: 'paddleCustomerId', value: customerId },
    { field: 'paddleSubscriptionId', value: subscriptionId },
  ] as const;

  if (!expectedUserId) {
    return;
  }

  for (const check of checks) {
    if (!check.value) {
      continue;
    }

    const wallet = await db.userWallet.findFirst({ where: { [check.field]: check.value } as any });
    if (!wallet) {
      continue;
    }

    if (String(wallet.userId) !== String(expectedUserId)) {
      logger.warn('Paddle ownership conflict detected', {
        alertName,
        ownerUserId: wallet.userId,
        expectedUserId,
        field: check.field,
        value: check.value,
      });
      throw new Error('Paddle ownership conflict: mapped Paddle customer or subscription belongs to another Mento user');
    }
  }
}

export async function processPaddleWebhook(rawPayload: string, signature: string, options?: {
  unmarshalOverride?: (payload: string, secret: string, signature: string) => Promise<ParsedPaddleEvent>;
  finalizeOverride?: (input: any) => Promise<any>;
  prismaOverride?: typeof prisma;
}) {
  const secret = getPaddleNotificationWebhookSecret();
  if (!secret) {
    throw new Error('Paddle webhook secret not configured');
  }

  let parsed: ParsedPaddleEvent;
  try {
    if (options?.unmarshalOverride) {
      parsed = await options.unmarshalOverride(rawPayload, secret, signature);
    } else {
      const paddle = getPaddleInstance();
      // paddle.webhooks.unmarshal will verify signature and parse payload
      // It may throw on invalid signature
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      parsed = await paddle.webhooks.unmarshal(rawPayload, secret, signature);
    }
  } catch (err) {
    logger.warn('Paddle webhook signature verification failed', { err: err instanceof Error ? err.message : String(err) });
    throw new Error('Invalid webhook signature');
  }

  const db = options?.prismaOverride ?? prisma;

  const alertName = String(parsed.alert_name ?? parsed.alertName ?? '').trim();
  const alertId = String(parsed.alert_id ?? parsed.alertId ?? parsed.notification_id ?? '');

  // Extract passthrough if present
  let passthrough: { mentoUserId?: string; transactionId?: string } | null = null;
  if (parsed.passthrough) {
    try {
      passthrough = JSON.parse(String(parsed.passthrough));
    } catch (e) {
      // ignore
    }
  }

  // Helper: check for already-processed webhook by looking for alert id in paymentTransaction.providerPayload.webhookIds
  async function isDuplicateForTransaction(transactionId?: string) {
    if (!transactionId) return false;
    const tx = await db.paymentTransaction.findUnique({ where: { id: transactionId } });
    if (!tx || !tx.providerPayload) return false;
    try {
      const payload = typeof tx.providerPayload === 'object' ? tx.providerPayload as any : JSON.parse(String(tx.providerPayload));
      const ids: string[] = Array.isArray(payload?.webhookIds) ? payload.webhookIds : [];
      return ids.includes(alertId);
    } catch (e) {
      return false;
    }
  }

  // If passthrough transactionId present, prefer using it
  const transactionId = passthrough?.transactionId;
  if (transactionId) {
    if (await isDuplicateForTransaction(transactionId)) {
      return { ok: true, duplicate: true };
    }

    const tx = await db.paymentTransaction.findUnique({ where: { id: transactionId } });
    if (!tx) {
      logger.warn('Paddle webhook: referenced transaction not found', { transactionId, alertName, alertId });
      // Still record nothing — return ok so webhook caller is satisfied
      return { ok: true, missingTransaction: true };
    }

    // Verify passthrough mentoUserId matches transaction's userId if provided
    if (passthrough?.mentoUserId && String(tx.userId) !== String(passthrough.mentoUserId)) {
      logger.warn('Paddle webhook passthrough user mismatch', { transactionId, txUserId: tx.userId, passthroughMentoUserId: passthrough.mentoUserId });
      throw new Error('Passthrough user mismatch');
    }

    const paddleCustomerId = String(parsed.customer_id ?? parsed.user_id ?? '');
    const paddleSubscriptionId = String(parsed.subscription_id ?? '');
    await assertPaddleOwnership(db, tx.userId, paddleCustomerId || undefined, paddleSubscriptionId || undefined, alertName);

    // Process common subscription/payment events
    switch (alertName) {
      case 'subscription_payment_succeeded':
      case 'subscription_payment_succeeded_v2':
      case 'subscription_payment_refunded':
      case 'subscription_payment_failed':
      case 'payment_succeeded':
        // Treat as payment finalize
        try {
          const providerTxId = String(parsed.checkout_id ?? parsed.sale_id ?? parsed.sale_gross ?? '');
          const providerSubscriptionId = String(parsed.subscription_id ?? '');
          const finalizeFn = options?.finalizeOverride ?? finalizePayment;
          await finalizeFn({
            transactionId: tx.id,
            provider: 'PADDLE',
            status: alertName.includes('failed') ? 'FAILED' : 'SUCCEEDED',
            providerTransactionId: providerTxId || undefined,
            providerSubscriptionId: providerSubscriptionId || undefined,
            providerPayload: parsed as Record<string, unknown>,
            idempotencyKey: tx.idempotencyKey ?? undefined,
          });
        } catch (err) {
          logger.warn('Failed to finalize payment from Paddle webhook', { err: err instanceof Error ? err.message : String(err) });
          throw err;
        }
        break;

      case 'subscription_created':
      case 'subscription_updated':
      case 'subscription_cancelled':
      case 'subscription_paused':
      case 'subscription_resumed':
        // Map customer/subscription/price ids onto UserWallet
        try {
          const paddleCustomerId = String(parsed.customer_id ?? parsed.user_id ?? '');
          const paddleSubscriptionId = String(parsed.subscription_id ?? '');
          const paddlePriceId = String(parsed.product_id ?? parsed.price_id ?? '');

          if (tx.userId) {
            const wallet = await db.userWallet.findUnique({ where: { userId: tx.userId } });
            if (wallet) {
              await assertPaddleOwnership(db, tx.userId, paddleCustomerId || undefined, paddleSubscriptionId || undefined, alertName);

              const update: any = {};
              if (paddleCustomerId) update.paddleCustomerId = paddleCustomerId;
              if (paddleSubscriptionId) update.paddleSubscriptionId = paddleSubscriptionId;
              if (paddlePriceId) update.paddlePriceId = paddlePriceId;

              // Handle cancel semantics: immediate vs scheduled
              if (alertName === 'subscription_cancelled') {
                const effective = parsed.cancellation_effective_at ?? parsed.cancellation_effective_date ?? parsed.cancellation_effective_timestamp ?? null;
                if (effective) {
                  update.subscriptionExpiresAt = new Date(String(effective));
                  update.subscriptionStatus = 'cancelled';
                } else {
                  update.subscriptionStatus = 'cancelled';
                }
              }

              await db.userWallet.update({ where: { userId: tx.userId }, data: update });
            }
          }
        } catch (err) {
          logger.warn('Failed to update UserWallet from Paddle subscription event', { err });
        }
        break;

      default:
        logger.info('Unhandled Paddle webhook alert', { alertName });
    }

    // Append webhook id to transaction.providerPayload.webhookIds to mark processed
    try {
      const payloadObj = tx.providerPayload && typeof tx.providerPayload === 'object' ? tx.providerPayload as any : {};
      const ids: string[] = Array.isArray(payloadObj.webhookIds) ? payloadObj.webhookIds : [];
      ids.push(alertId);
      payloadObj.webhookIds = ids;
      await db.paymentTransaction.update({ where: { id: tx.id }, data: { providerPayload: payloadObj as any, lastWebhookAt: new Date() } });
    } catch (e) {
      logger.warn('Failed to persist webhook id to transaction', { err: e });
    }

    return { ok: true };
  }

  // No transaction mapping; try to handle subscription-level events by subscription_id or customer_id
  const subscriptionId = String(parsed.subscription_id ?? '');
  const customerId = String(parsed.customer_id ?? parsed.user_id ?? '');

  if (!subscriptionId && !customerId) {
    logger.warn('Paddle webhook without transaction or subscription mapping', { alertName, alertId });
    return { ok: true, unmapped: true };
  }

  // Find user wallet by subscription or customer id
  let wallet = null;
  if (subscriptionId) {
    wallet = await db.userWallet.findFirst({ where: { paddleSubscriptionId: subscriptionId } });
  }
  if (!wallet && customerId) {
    wallet = await db.userWallet.findFirst({ where: { paddleCustomerId: customerId } });
  }

  if (!wallet) {
    logger.warn('Paddle webhook could not map to a UserWallet', { subscriptionId, customerId, alertName });
    return { ok: true, unmapped: true };
  }

  if (passthrough?.mentoUserId && String(wallet.userId) !== String(passthrough.mentoUserId)) {
    logger.warn('Paddle webhook wallet ownership mismatch', { walletUserId: wallet.userId, passthroughMentoUserId: passthrough.mentoUserId, subscriptionId, customerId, alertName });
    throw new Error('Paddle ownership conflict: mapped Paddle customer or subscription belongs to another Mento user');
  }

  await assertPaddleOwnership(db, wallet.userId, customerId || undefined, subscriptionId || undefined, alertName);

  // Deduplicate by checking recent transactions for this wallet for the alert id
  const recent = await db.paymentTransaction.findMany({ where: { userId: wallet.userId }, orderBy: { createdAt: 'desc' }, take: 20 });
  for (const r of recent) {
    try {
      const p = typeof r.providerPayload === 'object' ? r.providerPayload as any : JSON.parse(String(r.providerPayload ?? '{}'));
      if (Array.isArray(p?.webhookIds) && p.webhookIds.includes(alertId)) {
        return { ok: true, duplicate: true };
      }
    } catch (e) {
      // ignore
    }
  }

  // Apply subscription-level updates
  try {
    const update: any = {};
    if (customerId) update.paddleCustomerId = customerId;
    if (subscriptionId) update.paddleSubscriptionId = subscriptionId;
    const paddlePriceId = String(parsed.product_id ?? parsed.price_id ?? '');
    if (paddlePriceId) update.paddlePriceId = paddlePriceId;

    if (alertName === 'subscription_cancelled') {
      const effective = parsed.cancellation_effective_at ?? parsed.cancellation_effective_date ?? null;
      if (effective) update.subscriptionExpiresAt = new Date(String(effective));
      update.subscriptionStatus = 'cancelled';
      // If immediate, remove PRO now
      if (!effective) {
        const proPlan = await getProPlan();
        const freePlan = await db.plan.findFirst({ where: { name: 'FREE' } });
        if (freePlan) {
          await db.userWallet.update({ where: { userId: wallet.userId }, data: { plan: { connect: { id: freePlan.id } }, subscriptionStatus: 'cancelled' } });
        }
      } else {
        await db.userWallet.update({ where: { userId: wallet.userId }, data: update });
      }
    } else if (alertName === 'subscription_created' || alertName === 'subscription_resumed' || alertName === 'subscription_updated') {
      await prisma.userWallet.update({ where: { userId: wallet.userId }, data: update });
    }
  } catch (err) {
    logger.warn('Failed to apply subscription-level paddle update', { err });
  }

  return { ok: true };
}

export default { processPaddleWebhook };
