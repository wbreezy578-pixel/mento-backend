import { createHash } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { Environment, SignedDataVerifier } from '@apple/app-store-server-library';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { getRequiredEnv } from '../lib/env';
import { finalizePayment, startPayment } from './paymentService';

export type NativeStoreProductId = 'mento_pro_monthly' | 'mento_live_tutor_50' | 'mento_live_tutor_100';

const PACKAGE_NAME = 'com.breezy.mento';
const PRODUCT_CATALOG: Record<NativeStoreProductId, {
  type: 'SUBSCRIPTION' | 'TOP_UP';
  amountUsd: number;
  minutes?: number;
}> = {
  mento_pro_monthly: { type: 'SUBSCRIPTION', amountUsd: 29 },
  mento_live_tutor_50: { type: 'TOP_UP', amountUsd: 10, minutes: 50 },
  mento_live_tutor_100: { type: 'TOP_UP', amountUsd: 20, minutes: 100 },
};

type GoogleSubscriptionPurchase = {
  acknowledgementState?: string;
  subscriptionState?: string;
  latestOrderId?: string;
  startTime?: string;
  lineItems?: Array<{
    productId?: string;
    expiryTime?: string;
    autoRenewingPlan?: { autoRenewEnabled?: boolean };
  }>;
};

type GoogleProductPurchase = {
  purchaseState?: number;
  consumptionState?: number;
  acknowledgementState?: number;
  orderId?: string;
  purchaseTimeMillis?: string;
  quantity?: number;
};

function isNativeStoreProductId(value: string): value is NativeStoreProductId {
  return Object.prototype.hasOwnProperty.call(PRODUCT_CATALOG, value);
}

function parseServiceAccount(): Record<string, unknown> {
  try {
    const value = JSON.parse(getRequiredEnv('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid object');
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not valid JSON.', { cause: error });
  }
}

async function googlePublisherRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const auth = new GoogleAuth({
    credentials: parseServiceAccount(),
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });
  const client = await auth.getClient();
  const accessToken = await client.getAccessToken();
  if (!accessToken.token) throw new Error('Unable to authenticate with Google Play Developer API.');

  const response = await fetch(`https://androidpublisher.googleapis.com/androidpublisher/v3${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken.token}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google Play verification failed (${response.status}): ${body.slice(0, 300)}`);
  }
  if (response.status === 204 || response.headers.get('content-length') === '0') return {} as T;
  return await response.json() as T;
}

function tokenKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function parseDate(value?: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function assertTokenOwnership(userId: string, purchaseToken: string): Promise<void> {
  const existing = await prisma.storePurchase.findUnique({
    where: { provider_purchaseToken: { provider: 'GOOGLE_PLAY', purchaseToken } },
    select: { userId: true },
  });
  if (existing?.userId && existing.userId !== userId) {
    throw new Error('This Google Play purchase is already associated with another account.');
  }
}

async function removeNativeSubscriptionEntitlement(userId: string): Promise<void> {
  const now = new Date();
  const [otherActive, wallet, freePlan] = await Promise.all([
    prisma.storePurchase.findFirst({
      where: { userId, purchaseType: 'SUBSCRIPTION', expiresAt: { gt: now }, status: { in: ['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'SUBSCRIPTION_STATE_CANCELED', 'ACTIVE'] } },
      select: { id: true },
    }),
    prisma.userWallet.findUnique({ where: { userId }, select: { paddleSubscriptionId: true } }),
    prisma.plan.findUnique({ where: { name: 'FREE' }, select: { id: true } }),
  ]);
  if (!otherActive && !wallet?.paddleSubscriptionId && freePlan) {
    await prisma.userWallet.update({ where: { userId }, data: { planId: freePlan.id, subscriptionStatus: 'inactive', subscriptionExpiresAt: null } });
  }
}

export async function verifyGooglePlayPurchase(input: {
  userId: string;
  productId: string;
  purchaseToken: string;
}): Promise<{ active: boolean; productId: NativeStoreProductId; status: string; transactionId: string }> {
  const productId = input.productId.trim();
  const purchaseToken = input.purchaseToken.trim();
  if (!isNativeStoreProductId(productId) || !purchaseToken || purchaseToken.length > 4096) {
    throw new Error('Invalid Google Play purchase payload.');
  }
  await assertTokenOwnership(input.userId, purchaseToken);
  const product = PRODUCT_CATALOG[productId];
  const encodedPackage = encodeURIComponent(PACKAGE_NAME);
  const encodedToken = encodeURIComponent(purchaseToken);

  if (product.type === 'SUBSCRIPTION') {
    const verified = await googlePublisherRequest<GoogleSubscriptionPurchase>(
      `/applications/${encodedPackage}/purchases/subscriptionsv2/tokens/${encodedToken}`,
    );
    const lineItem = verified.lineItems?.find((item) => item.productId === productId);
    if (!lineItem) throw new Error('Google Play returned a different subscription product.');
    const expiresAt = parseDate(lineItem.expiryTime);
    const activeStates = new Set(['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'SUBSCRIPTION_STATE_CANCELED']);
    const active = activeStates.has(verified.subscriptionState ?? '') && Boolean(expiresAt && expiresAt.getTime() > Date.now());
    if (!active) {
      await prisma.storePurchase.updateMany({
        where: { provider: 'GOOGLE_PLAY', purchaseToken, userId: input.userId },
        data: { status: verified.subscriptionState ?? 'UNKNOWN', expiresAt, autoRenewing: lineItem.autoRenewingPlan?.autoRenewEnabled ?? null, rawPayload: verified as Prisma.InputJsonObject, lastVerifiedAt: new Date() },
      });
      await removeNativeSubscriptionEntitlement(input.userId);
      throw new Error('The Google Play subscription is not active.');
    }

    const payment = await startPayment({
      userId: input.userId,
      provider: 'GOOGLE_PLAY',
      type: 'SUBSCRIPTION',
      amountUsd: product.amountUsd,
      providerTransactionId: verified.latestOrderId,
      providerSubscriptionId: tokenKey(purchaseToken),
      // Google keeps the purchase token for the subscription lifetime but issues a
      // new order for renewals. Key by order so every renewal reaches the ledger.
      idempotencyKey: `google-play:${verified.latestOrderId ?? tokenKey(purchaseToken)}`,
      metadata: { productId, store: 'google_play' },
      description: 'Mento Pro monthly subscription',
    });
    const owner = await prisma.paymentTransaction.findUnique({ where: { id: payment.id }, select: { userId: true } });
    if (owner?.userId !== input.userId) throw new Error('Purchase ownership verification failed.');
    await finalizePayment({
      transactionId: payment.id,
      provider: 'GOOGLE_PLAY',
      status: 'SUCCEEDED',
      providerTransactionId: verified.latestOrderId,
      providerSubscriptionId: tokenKey(purchaseToken),
      providerPayload: verified as Prisma.InputJsonObject,
    });
    if (verified.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING') {
      await googlePublisherRequest(
        `/applications/${encodedPackage}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodedToken}:acknowledge`,
        { method: 'POST', body: '{}' },
      );
    }
    await prisma.storePurchase.upsert({
      where: { provider_purchaseToken: { provider: 'GOOGLE_PLAY', purchaseToken } },
      create: {
        userId: input.userId, paymentTransactionId: payment.id, provider: 'GOOGLE_PLAY', productId,
        purchaseToken, transactionId: verified.latestOrderId, originalTransactionId: tokenKey(purchaseToken),
        purchaseType: 'SUBSCRIPTION', status: verified.subscriptionState ?? 'UNKNOWN', purchasedAt: parseDate(verified.startTime),
        expiresAt, autoRenewing: lineItem.autoRenewingPlan?.autoRenewEnabled ?? null, acknowledged: true,
        environment: 'PRODUCTION', rawPayload: verified as Prisma.InputJsonObject,
      },
      update: {
        userId: input.userId, paymentTransactionId: payment.id, transactionId: verified.latestOrderId,
        status: verified.subscriptionState ?? 'UNKNOWN', expiresAt,
        autoRenewing: lineItem.autoRenewingPlan?.autoRenewEnabled ?? null, acknowledged: true,
        rawPayload: verified as Prisma.InputJsonObject, lastVerifiedAt: new Date(),
      },
    });
    return { active: true, productId, status: verified.subscriptionState ?? 'UNKNOWN', transactionId: payment.id };
  }

  const verified = await googlePublisherRequest<GoogleProductPurchase>(
    `/applications/${encodedPackage}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodedToken}`,
  );
  if (verified.purchaseState !== 0) throw new Error('The Google Play purchase is not completed.');
  const payment = await startPayment({
    userId: input.userId,
    provider: 'GOOGLE_PLAY',
    type: 'TOP_UP',
    amountUsd: product.amountUsd,
    providerTransactionId: verified.orderId,
    idempotencyKey: `google-play:${tokenKey(purchaseToken)}`,
    metadata: { productId, store: 'google_play', topUpMinutes: product.minutes },
    description: `Mento ${product.minutes}-minute Live Tutor top-up`,
  });
  const owner = await prisma.paymentTransaction.findUnique({ where: { id: payment.id }, select: { userId: true } });
  if (owner?.userId !== input.userId) throw new Error('Purchase ownership verification failed.');
  await finalizePayment({
    transactionId: payment.id,
    provider: 'GOOGLE_PLAY',
    status: 'SUCCEEDED',
    providerTransactionId: verified.orderId,
    providerPayload: verified as Prisma.InputJsonObject,
  });
  if (verified.consumptionState !== 1) {
    await googlePublisherRequest(
      `/applications/${encodedPackage}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodedToken}:consume`,
      { method: 'POST' },
    );
  }
  await prisma.storePurchase.upsert({
    where: { provider_purchaseToken: { provider: 'GOOGLE_PLAY', purchaseToken } },
    create: {
      userId: input.userId, paymentTransactionId: payment.id, provider: 'GOOGLE_PLAY', productId,
      purchaseToken, transactionId: verified.orderId, purchaseType: 'CONSUMABLE', status: 'PURCHASED',
      quantity: verified.quantity ?? 1, purchasedAt: verified.purchaseTimeMillis ? new Date(Number(verified.purchaseTimeMillis)) : null,
      acknowledged: true, consumed: true, environment: 'PRODUCTION', rawPayload: verified as Prisma.InputJsonObject,
    },
    update: { userId: input.userId, paymentTransactionId: payment.id, status: 'PURCHASED', acknowledged: true, consumed: true, rawPayload: verified as Prisma.InputJsonObject, lastVerifiedAt: new Date() },
  });
  return { active: true, productId, status: 'PURCHASED', transactionId: payment.id };
}

export const nativeStoreCatalog = PRODUCT_CATALOG;

export async function cancelGooglePlaySubscriptionsForAccountDeletion(userId: string): Promise<number> {
  const subscriptions = await prisma.storePurchase.findMany({
    where: { userId, provider: 'GOOGLE_PLAY', purchaseType: 'SUBSCRIPTION', status: { notIn: ['EXPIRED', 'REFUNDED', 'REVOKED', 'CANCELED_BY_USER'] } },
    select: { id: true, purchaseToken: true },
  });
  for (const subscription of subscriptions) {
    await googlePublisherRequest(
      `/applications/${encodeURIComponent(PACKAGE_NAME)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(subscription.purchaseToken)}:cancel`,
      { method: 'POST', body: JSON.stringify({ cancellationContext: { cancellationType: 'USER_REQUESTED_STOP_RENEWALS' } }) },
    );
    await prisma.storePurchase.update({ where: { id: subscription.id }, data: { autoRenewing: false, status: 'CANCELED_BY_USER', lastVerifiedAt: new Date() } });
  }
  return subscriptions.length;
}

export async function processGooglePlayRtdn(encodedData: string): Promise<{ handled: boolean; type: string }> {
  const decoded = JSON.parse(Buffer.from(encodedData, 'base64').toString('utf8')) as {
    packageName?: string;
    subscriptionNotification?: { notificationType?: number; purchaseToken?: string; subscriptionId?: string };
    oneTimeProductNotification?: { notificationType?: number; purchaseToken?: string; sku?: string };
  };
  if (decoded.packageName !== PACKAGE_NAME) throw new Error('RTDN package name mismatch.');
  const subscription = decoded.subscriptionNotification;
  if (subscription?.purchaseToken) {
    const existing = await prisma.storePurchase.findUnique({ where: { provider_purchaseToken: { provider: 'GOOGLE_PLAY', purchaseToken: subscription.purchaseToken } } });
    if (!existing?.userId) return { handled: false, type: `subscription:${subscription.notificationType ?? 'unknown'}` };
    try {
      await verifyGooglePlayPurchase({ userId: existing.userId, productId: subscription.subscriptionId ?? existing.productId, purchaseToken: subscription.purchaseToken });
    } catch (error) {
      if (!/not active/i.test(error instanceof Error ? error.message : '')) throw error;
    }
    return { handled: true, type: `subscription:${subscription.notificationType ?? 'unknown'}` };
  }
  const oneTime = decoded.oneTimeProductNotification;
  if (oneTime?.purchaseToken) {
    const existing = await prisma.storePurchase.findUnique({ where: { provider_purchaseToken: { provider: 'GOOGLE_PLAY', purchaseToken: oneTime.purchaseToken } } });
    if (!existing?.userId) return { handled: false, type: `one-time:${oneTime.notificationType ?? 'unknown'}` };
    if (oneTime.notificationType === 2) {
      await prisma.$transaction(async (tx) => {
        const update = await tx.storePurchase.updateMany({
          where: { id: existing.id, status: { not: 'REFUNDED' } },
          data: { status: 'REFUNDED', lastVerifiedAt: new Date() },
        });
        if (update.count === 0) return;
        if (existing.paymentTransactionId) await tx.paymentTransaction.update({ where: { id: existing.paymentTransactionId }, data: { status: 'REFUNDED' } });
        const minutes = isNativeStoreProductId(existing.productId) ? PRODUCT_CATALOG[existing.productId].minutes ?? 0 : 0;
        if (minutes > 0) {
          const wallet = await tx.liveTutorWallet.findUnique({ where: { userId: existing.userId! } });
          if (wallet) await tx.liveTutorWallet.update({ where: { userId: existing.userId! }, data: { minutesBalance: Math.max(0, wallet.minutesBalance - minutes) } });
        }
      });
    }
    return { handled: true, type: `one-time:${oneTime.notificationType ?? 'unknown'}` };
  }
  return { handled: false, type: 'test-or-unknown' };
}

function appleRootCertificates(): Buffer[] {
  return getRequiredEnv('APPLE_ROOT_CERTIFICATES_BASE64')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => Buffer.from(value, 'base64'));
}

function appleVerifier(environment: Environment): SignedDataVerifier {
  const appAppleId = environment === Environment.PRODUCTION ? Number(getRequiredEnv('APPLE_APP_ID')) : undefined;
  return new SignedDataVerifier(appleRootCertificates(), true, environment, PACKAGE_NAME, appAppleId);
}

export async function verifyAppleStorePurchase(input: {
  userId: string;
  productId: string;
  signedTransaction: string;
}): Promise<{ active: boolean; productId: NativeStoreProductId; status: string; transactionId: string }> {
  const productId = input.productId.trim();
  const signedTransaction = input.signedTransaction.trim();
  if (!isNativeStoreProductId(productId) || !signedTransaction || signedTransaction.length > 20_000) {
    throw new Error('Invalid App Store purchase payload.');
  }
  let decoded;
  let verifiedEnvironment: 'PRODUCTION' | 'SANDBOX' = 'PRODUCTION';
  try {
    decoded = await appleVerifier(Environment.PRODUCTION).verifyAndDecodeTransaction(signedTransaction);
  } catch {
    verifiedEnvironment = 'SANDBOX';
    decoded = await appleVerifier(Environment.SANDBOX).verifyAndDecodeTransaction(signedTransaction);
  }
  if (decoded.productId !== productId || !decoded.transactionId) throw new Error('Apple returned a different or incomplete product transaction.');
  if (decoded.revocationDate) throw new Error('This App Store purchase has been revoked or refunded.');
  const product = PRODUCT_CATALOG[productId];
  const expiresAt = decoded.expiresDate ? new Date(decoded.expiresDate) : null;
  const active = product.type === 'TOP_UP' || Boolean(expiresAt && expiresAt.getTime() > Date.now());
  if (!active) throw new Error('The App Store subscription is not active.');
  await assertAppleTransactionOwnership(input.userId, decoded.transactionId);

  const payment = await startPayment({
    userId: input.userId,
    provider: 'APPLE_APP_STORE',
    type: product.type,
    amountUsd: product.amountUsd,
    providerTransactionId: `apple:${decoded.transactionId}`,
    providerSubscriptionId: decoded.originalTransactionId,
    idempotencyKey: `apple:${decoded.transactionId}`,
    metadata: { productId, store: 'apple_app_store', topUpMinutes: product.minutes },
    description: product.type === 'SUBSCRIPTION' ? 'Mento Pro monthly subscription' : `Mento ${product.minutes}-minute Live Tutor top-up`,
  });
  const owner = await prisma.paymentTransaction.findUnique({ where: { id: payment.id }, select: { userId: true } });
  if (owner?.userId !== input.userId) throw new Error('Purchase ownership verification failed.');
  await finalizePayment({
    transactionId: payment.id,
    provider: 'APPLE_APP_STORE',
    status: 'SUCCEEDED',
    providerTransactionId: `apple:${decoded.transactionId}`,
    providerSubscriptionId: decoded.originalTransactionId,
    providerPayload: decoded as Prisma.InputJsonObject,
  });
  await prisma.storePurchase.upsert({
    where: { provider_purchaseToken: { provider: 'APPLE_APP_STORE', purchaseToken: decoded.transactionId } },
    create: {
      userId: input.userId, paymentTransactionId: payment.id, provider: 'APPLE_APP_STORE', productId,
      purchaseToken: decoded.transactionId, transactionId: decoded.transactionId, originalTransactionId: decoded.originalTransactionId,
      purchaseType: product.type === 'SUBSCRIPTION' ? 'SUBSCRIPTION' : 'CONSUMABLE', status: 'ACTIVE',
      quantity: decoded.quantity ?? 1, purchasedAt: decoded.purchaseDate ? new Date(decoded.purchaseDate) : null,
      expiresAt, acknowledged: true, consumed: product.type === 'TOP_UP', environment: verifiedEnvironment,
      rawPayload: decoded as Prisma.InputJsonObject,
    },
    update: { userId: input.userId, paymentTransactionId: payment.id, status: 'ACTIVE', expiresAt, rawPayload: decoded as Prisma.InputJsonObject, lastVerifiedAt: new Date() },
  });
  return { active: true, productId, status: 'ACTIVE', transactionId: payment.id };
}

async function assertAppleTransactionOwnership(userId: string, transactionId: string): Promise<void> {
  const existing = await prisma.storePurchase.findUnique({
    where: { provider_purchaseToken: { provider: 'APPLE_APP_STORE', purchaseToken: transactionId } },
    select: { userId: true },
  });
  if (existing?.userId && existing.userId !== userId) throw new Error('This App Store purchase is already associated with another account.');
}

export async function processAppleStoreNotification(signedPayload: string): Promise<{ eventId: string; type: string; handled: boolean }> {
  let notification;
  let environment: Environment;
  try {
    environment = Environment.PRODUCTION;
    notification = await appleVerifier(environment).verifyAndDecodeNotification(signedPayload);
  } catch {
    environment = Environment.SANDBOX;
    notification = await appleVerifier(environment).verifyAndDecodeNotification(signedPayload);
  }
  const eventId = notification.notificationUUID ?? tokenKey(signedPayload);
  const type = `${notification.notificationType ?? 'UNKNOWN'}${notification.subtype ? `:${notification.subtype}` : ''}`;
  const signedTransaction = notification.data?.signedTransactionInfo;
  if (!signedTransaction) return { eventId, type, handled: false };
  const transaction = await appleVerifier(environment).verifyAndDecodeTransaction(signedTransaction);
  const existing = await prisma.storePurchase.findFirst({
    where: {
      provider: 'APPLE_APP_STORE',
      OR: [
        ...(transaction.transactionId ? [{ transactionId: transaction.transactionId }] : []),
        ...(transaction.originalTransactionId ? [{ originalTransactionId: transaction.originalTransactionId }] : []),
      ],
    },
  });
  if (!existing?.userId || !transaction.productId) return { eventId, type, handled: false };
  const revoked = Boolean(transaction.revocationDate) || ['REFUND', 'REVOKE'].includes(String(notification.notificationType));
  const expired = notification.notificationType === 'EXPIRED' || Boolean(transaction.expiresDate && transaction.expiresDate <= Date.now());
  if (revoked || expired) {
    await prisma.$transaction(async (tx) => {
      const update = revoked
        ? await tx.storePurchase.updateMany({
            where: { id: existing.id, status: { not: 'REFUNDED' } },
            data: { status: 'REFUNDED', expiresAt: transaction.expiresDate ? new Date(transaction.expiresDate) : existing.expiresAt, rawPayload: transaction as Prisma.InputJsonObject, lastVerifiedAt: new Date() },
          })
        : await tx.storePurchase.updateMany({
            where: { id: existing.id, status: { not: 'EXPIRED' } },
            data: { status: 'EXPIRED', expiresAt: transaction.expiresDate ? new Date(transaction.expiresDate) : existing.expiresAt, rawPayload: transaction as Prisma.InputJsonObject, lastVerifiedAt: new Date() },
          });
      // The conditional update is the idempotency gate. Duplicate or concurrent
      // notifications must not reverse the same entitlement more than once.
      if (update.count === 0) return;
      if (existing.paymentTransactionId && revoked) await tx.paymentTransaction.update({ where: { id: existing.paymentTransactionId }, data: { status: 'REFUNDED' } });
      if (revoked && isNativeStoreProductId(existing.productId)) {
        const minutes = PRODUCT_CATALOG[existing.productId].minutes ?? 0;
        if (minutes > 0) {
          const wallet = await tx.liveTutorWallet.findUnique({ where: { userId: existing.userId! } });
          if (wallet) await tx.liveTutorWallet.update({ where: { userId: existing.userId! }, data: { minutesBalance: Math.max(0, wallet.minutesBalance - minutes) } });
        }
      }
    });
    if (existing.purchaseType === 'SUBSCRIPTION') await removeNativeSubscriptionEntitlement(existing.userId);
    return { eventId, type, handled: true };
  }
  await verifyAppleStorePurchase({ userId: existing.userId, productId: transaction.productId, signedTransaction });
  return { eventId, type, handled: true };
}
