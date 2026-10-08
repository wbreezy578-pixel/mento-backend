import { createHash } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { Environment, SignedDataVerifier } from '@apple/app-store-server-library';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { getRequiredEnv } from '../lib/env';
import { finalizePayment, startPayment } from './paymentService';
import { applyVerifiedEntitlementEvent, type CanonicalEntitlementStatus } from './entitlementService';
import { isIdempotentProviderCancellationError } from './accountDeletionPolicy';
import { WEBSITE_PAYMENT_GRACE_DAYS } from './websiteBillingService';

const PRODUCTION_PACKAGE_NAME = 'com.trymentoapp.mento';
const BLUE_TEST_PACKAGE_NAME = 'com.trymentoapp.mento.blue';
const PRODUCTION_HOSTING_PRODUCT_ID = 'mento_hosting_slot';
const BLUE_TEST_HOSTING_PRODUCT_ID = 'mento_blue_hosting_slot';
const WEBSITE_HOSTING_BASE_PLANS = {
  'sites-1': { tier: 'SITES_1', siteLimit: 1 },
  'sites-3': { tier: 'SITES_3', siteLimit: 3 },
  'sites-5': { tier: 'SITES_5', siteLimit: 5 },
} as const;
function getWebsiteHostingBasePlan(basePlanId?: string) {
  switch (basePlanId) {
    case 'sites-1': return WEBSITE_HOSTING_BASE_PLANS['sites-1'];
    case 'sites-3': return WEBSITE_HOSTING_BASE_PLANS['sites-3'];
    case 'sites-5': return WEBSITE_HOSTING_BASE_PLANS['sites-5'];
    default: return undefined;
  }
}

type NativeStoreProduct =
  | { type: 'SUBSCRIPTION' | 'TOP_UP'; amountUsd: number; minutes?: number }
  | { type: 'HOSTING_SUBSCRIPTION' };

const PRODUCTION_PRODUCT_CATALOG = {
  mento_pro_monthly: { type: 'SUBSCRIPTION', amountUsd: 29 },
  mento_live_tutor_50: { type: 'TOP_UP', amountUsd: 10, minutes: 50 },
  mento_live_tutor_100: { type: 'TOP_UP', amountUsd: 20, minutes: 100 },
  [PRODUCTION_HOSTING_PRODUCT_ID]: { type: 'HOSTING_SUBSCRIPTION' },
} satisfies Record<string, NativeStoreProduct>;

const BLUE_TEST_PRODUCT_CATALOG = {
  mento_blue_pro_monthly: { type: 'SUBSCRIPTION', amountUsd: 29 },
  mento_blue_live_tutor_50: { type: 'TOP_UP', amountUsd: 10, minutes: 50 },
  mento_blue_live_tutor_100: { type: 'TOP_UP', amountUsd: 20, minutes: 100 },
  [BLUE_TEST_HOSTING_PRODUCT_ID]: { type: 'HOSTING_SUBSCRIPTION' },
} satisfies Record<string, NativeStoreProduct>;

export type NativeStoreProductId =
  | keyof typeof PRODUCTION_PRODUCT_CATALOG
  | keyof typeof BLUE_TEST_PRODUCT_CATALOG;
type ProductionNativeStoreProductId = keyof typeof PRODUCTION_PRODUCT_CATALOG;
type NativeStoreProductCatalog = Partial<Record<NativeStoreProductId, NativeStoreProduct>>;
type GooglePlayBillingConfig = {
  packageName: string;
  productCatalog: NativeStoreProductCatalog;
  hostingProductId: NativeStoreProductId;
  environment: 'PRODUCTION' | 'TEST';
};

const GOOGLE_PLAY_PRODUCTION_CONFIG: GooglePlayBillingConfig = {
  packageName: PRODUCTION_PACKAGE_NAME,
  productCatalog: PRODUCTION_PRODUCT_CATALOG,
  hostingProductId: PRODUCTION_HOSTING_PRODUCT_ID,
  environment: 'PRODUCTION',
};

const GOOGLE_PLAY_BLUE_TEST_CONFIG: GooglePlayBillingConfig = {
  packageName: BLUE_TEST_PACKAGE_NAME,
  productCatalog: BLUE_TEST_PRODUCT_CATALOG,
  hostingProductId: BLUE_TEST_HOSTING_PRODUCT_ID,
  environment: 'TEST',
};

type GoogleSubscriptionPurchase = {
  acknowledgementState?: string;
  subscriptionState?: string;
  startTime?: string;
  linkedPurchaseToken?: string;
  lineItems?: Array<{
    productId?: string;
    expiryTime?: string;
    latestSuccessfulOrderId?: string;
    offerDetails?: { basePlanId?: string };
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

class GooglePlayPublisherError extends Error {
  public readonly idempotentTerminal: boolean;

  constructor(public readonly status: number, providerBody: string) {
    super(`Google Play request failed with status ${status}.`);
    this.name = 'GooglePlayPublisherError';
    this.idempotentTerminal = status === 404 || status === 410
      || /already (?:cancelled|canceled|deleted)|subscription (?:is )?(?:cancelled|canceled)|not found/i.test(providerBody);
  }
}

function isNativeStoreProductId(value: string): value is NativeStoreProductId {
  return Object.prototype.hasOwnProperty.call(PRODUCTION_PRODUCT_CATALOG, value)
    || Object.prototype.hasOwnProperty.call(BLUE_TEST_PRODUCT_CATALOG, value);
}

function isProductionNativeStoreProductId(value: string): value is ProductionNativeStoreProductId {
  return Object.prototype.hasOwnProperty.call(PRODUCTION_PRODUCT_CATALOG, value);
}

function isBlueTestDatabaseUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'postgresql:'
      && url.pathname === '/mento_blue'
      && url.searchParams.get('host') === '/cloudsql/mento-cloud-migration:us-east4:mento-blue-db';
  } catch {
    return false;
  }
}

function readOptionalEnv(name: string): string | undefined {
  try {
    return getRequiredEnv(name);
  } catch (error) {
    if (error instanceof Error && error.message.includes(`Environment variable "${name}" is required`)) return undefined;
    throw error;
  }
}

function getGooglePlayBillingConfig(): GooglePlayBillingConfig {
  const serviceName = readOptionalEnv('K_SERVICE');
  const configuredMode = readOptionalEnv('GOOGLE_PLAY_BILLING_MODE');
  const isBlueService = serviceName === 'mento-backend-blue';

  if (isBlueService && configuredMode !== 'blue-test') {
    throw new Error('Google Play billing is disabled on Blue until its isolated test configuration is enabled.');
  }
  if (configuredMode === 'blue-test') {
    if (serviceName && !isBlueService) {
      throw new Error('Blue test billing cannot be enabled on the production service.');
    }
    if (readOptionalEnv('GOOGLE_PLAY_PACKAGE_NAME') !== BLUE_TEST_PACKAGE_NAME) {
      throw new Error('Blue Google Play billing requires the dedicated Blue test package.');
    }
    if (
      !isBlueTestDatabaseUrl(readOptionalEnv('DATABASE_URL'))
      || !isBlueTestDatabaseUrl(readOptionalEnv('DIRECT_URL'))
    ) {
      throw new Error('Blue test billing requires both database URLs to use the isolated Blue database.');
    }
    return GOOGLE_PLAY_BLUE_TEST_CONFIG;
  }
  if (configuredMode && configuredMode !== 'production') {
    throw new Error('Google Play billing mode is invalid.');
  }
  const configuredPackageName = readOptionalEnv('GOOGLE_PLAY_PACKAGE_NAME');
  if (configuredPackageName && configuredPackageName !== PRODUCTION_PACKAGE_NAME) {
    throw new Error('Production Google Play billing cannot use a non-production package.');
  }
  return GOOGLE_PLAY_PRODUCTION_CONFIG;
}

function parseGooglePlayCredentials(): Record<string, unknown> {
  const raw = readOptionalEnv('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON');

  if (!raw) {
    throw new Error('Google Play authentication is not configured. Set GOOGLE_PLAY_SERVICE_ACCOUNT_JSON.');
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid object');
  } catch (error) {
    throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not valid Google Auth configuration JSON.', { cause: error });
  }
  return value as Record<string, unknown>;
}

function createGooglePlayAuth(): GoogleAuth {
  const scopes = ['https://www.googleapis.com/auth/androidpublisher'];

  // Cloud Run provides short-lived Application Default Credentials for the
  // service identity attached to this revision. Prefer them over the legacy
  // Cloud Run uses short-lived Application Default Credentials from its
  // attached service identity, keeping Play verification keyless.
  if (readOptionalEnv('K_SERVICE')) {
    return new GoogleAuth({ scopes });
  }

  return new GoogleAuth({
    credentials: parseGooglePlayCredentials(),
    scopes,
  });
}

async function googlePublisherRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const auth = createGooglePlayAuth();
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
    throw new GooglePlayPublisherError(response.status, body.slice(0, 300));
  }
  if (response.status === 204 || response.headers.get('content-length') === '0') return {} as T;
  return await response.json() as T;
}

function tokenKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const GOOGLE_SUBSCRIPTION_STATUS: Record<string, CanonicalEntitlementStatus> = {
  SUBSCRIPTION_STATE_ACTIVE: 'ACTIVE',
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: 'GRACE_PERIOD',
  SUBSCRIPTION_STATE_CANCELED: 'CANCELLED',
  SUBSCRIPTION_STATE_ON_HOLD: 'ON_HOLD',
  SUBSCRIPTION_STATE_PAUSED: 'ON_HOLD',
  SUBSCRIPTION_STATE_EXPIRED: 'EXPIRED',
};

function getGoogleSubscriptionStatus(subscriptionState?: string): CanonicalEntitlementStatus {
  const status = GOOGLE_SUBSCRIPTION_STATUS[subscriptionState ?? ''];
  if (!status) throw new Error('Google Play returned an unknown subscription state.');
  return status;
}

function getGoogleSubscriptionTransactionId(
  purchaseToken: string,
  startTime: string | undefined,
  expiryTime: string | undefined,
  latestSuccessfulOrderId: string | undefined,
): string {
  const orderId = latestSuccessfulOrderId?.trim();
  if (orderId) return orderId;
  return `google-play-period:${tokenKey(purchaseToken)}:${tokenKey(`${startTime ?? ''}:${expiryTime ?? ''}`)}`;
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

async function verifyGooglePlayHostingPurchase(
  userId: string,
  purchaseToken: string,
  config: GooglePlayBillingConfig,
): Promise<{ active: boolean; productId: NativeStoreProductId; status: string; transactionId: string }> {
  const productId = config.hostingProductId;
  const encodedPackage = encodeURIComponent(config.packageName);
  const encodedToken = encodeURIComponent(purchaseToken);
  const verified = await googlePublisherRequest<GoogleSubscriptionPurchase>(
    `/applications/${encodedPackage}/purchases/subscriptionsv2/tokens/${encodedToken}`,
  );
  const lineItems = verified.lineItems?.filter((item) => item.productId === productId) ?? [];
  if (lineItems.length !== 1) throw new Error('Google Play returned a different or ambiguous hosting subscription product.');
  const lineItem = lineItems[0];
  const basePlan = getWebsiteHostingBasePlan(lineItem.offerDetails?.basePlanId);
  if (!basePlan) throw new Error('Google Play returned an unsupported website hosting tier.');
  const expiresAt = parseDate(lineItem.expiryTime);
  const periodStart = parseDate(verified.startTime);
  if (!expiresAt || !periodStart) throw new Error('Google Play returned an incomplete hosting subscription period.');
  const status = getGoogleSubscriptionStatus(verified.subscriptionState);
  const transactionId = getGoogleSubscriptionTransactionId(
    purchaseToken,
    verified.startTime,
    lineItem.expiryTime,
    lineItem.latestSuccessfulOrderId,
  );
  const active = ['ACTIVE', 'GRACE_PERIOD', 'CANCELLED'].includes(status)
    && expiresAt.getTime() > Date.now();
  const graceDeadlineAt = status === 'ON_HOLD'
    ? new Date(expiresAt.getTime() + WEBSITE_PAYMENT_GRACE_DAYS * 24 * 60 * 60 * 1000)
    : status === 'GRACE_PERIOD' ? expiresAt : null;

  const purchaseTokenHash = tokenKey(purchaseToken);
  const [tokenOwner, userAccount] = await Promise.all([
    prisma.websiteHostingAccount.findUnique({
      where: { providerPurchaseTokenHash: purchaseTokenHash },
      select: { userId: true },
    }),
    prisma.websiteHostingAccount.findUnique({
      where: { userId },
      select: { providerPurchaseTokenHash: true, status: true, paidThroughAt: true },
    }),
  ]);
  if (tokenOwner && tokenOwner.userId !== userId) {
    throw new Error('This Google Play hosting purchase is already associated with another account.');
  }

  const now = new Date();
  const linkedTokenMatchesAccount = Boolean(
    verified.linkedPurchaseToken
    && userAccount?.providerPurchaseTokenHash
    && tokenKey(verified.linkedPurchaseToken) === userAccount.providerPurchaseTokenHash,
  );
  if (
    userAccount?.providerPurchaseTokenHash
    && userAccount.providerPurchaseTokenHash !== purchaseTokenHash
    && userAccount.paidThroughAt
    && userAccount.paidThroughAt > now
    && ['ACTIVE', 'GRACE_PERIOD', 'CANCELLED'].includes(userAccount.status)
    && !linkedTokenMatchesAccount
  ) {
    throw new Error('This account already has an active Google Play hosting subscription.');
  }
  if (verified.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING') {
    await googlePublisherRequest(
      `/applications/${encodedPackage}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodedToken}:acknowledge`,
      { method: 'POST', body: '{}' },
    );
  }

  await prisma.$transaction(async (tx) => {
    const hostingData = {
      tier: basePlan.tier,
      siteLimit: basePlan.siteLimit,
      status,
      provider: 'GOOGLE_PLAY',
      providerProductId: productId,
      providerSubscriptionId: purchaseTokenHash,
      providerPurchaseTokenHash: purchaseTokenHash,
      currentPeriodStart: periodStart,
      paidThroughAt: expiresAt,
      graceDeadlineAt,
      lastVerifiedAt: now,
    };
    await tx.websiteHostingAccount.upsert({
      where: { userId },
      create: { userId, ...hostingData },
      update: hostingData,
    });
    await tx.storePurchase.upsert({
      where: { provider_purchaseToken: { provider: 'GOOGLE_PLAY', purchaseToken } },
      create: {
        userId,
        provider: 'GOOGLE_PLAY',
        productId,
        purchaseToken,
        transactionId,
        originalTransactionId: purchaseTokenHash,
        purchaseType: 'SUBSCRIPTION',
        status: verified.subscriptionState ?? 'UNKNOWN',
        purchasedAt: periodStart,
        expiresAt,
        autoRenewing: lineItem.autoRenewingPlan?.autoRenewEnabled ?? null,
        acknowledged: true,
        environment: config.environment,
        rawPayload: verified as Prisma.InputJsonObject,
      },
      update: {
        userId,
        transactionId,
        status: verified.subscriptionState ?? 'UNKNOWN',
        expiresAt,
        autoRenewing: lineItem.autoRenewingPlan?.autoRenewEnabled ?? null,
        acknowledged: true,
        rawPayload: verified as Prisma.InputJsonObject,
        lastVerifiedAt: now,
      },
    });
  });

  return {
    active,
    productId,
    status: verified.subscriptionState ?? 'UNKNOWN',
    transactionId,
  };
}

async function removeNativeSubscriptionEntitlement(userId: string): Promise<void> {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const [otherActive, freePlan] = await Promise.all([
      tx.storePurchase.findFirst({
        where: { userId, purchaseType: 'SUBSCRIPTION', expiresAt: { gt: now }, status: { in: ['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'SUBSCRIPTION_STATE_CANCELED', 'ACTIVE'] } },
        select: { id: true },
      }),
      tx.plan.findUnique({ where: { name: 'FREE' }, select: { id: true } }),
    ]);
    if (!otherActive && freePlan) {
      await tx.userWallet.updateMany({ where: { userId }, data: { planId: freePlan.id, subscriptionStatus: 'inactive', subscriptionExpiresAt: null } });
      const liveWallet = await tx.liveTutorWallet.findUnique({ where: { userId } });
      if (liveWallet) {
        // Included minutes belong to the subscription period. Purchased
        // top-ups remain durable, while the rounded legacy balance is kept in
        // sync with those exact seconds for the next eligible period.
        await tx.liveTutorWallet.update({
          where: { userId },
          data: {
            includedSeconds: 0,
            includedPeriodStart: null,
            includedPeriodEnd: null,
            minutesBalance: Math.floor(Math.max(0, liveWallet.topUpSeconds) / 60),
          },
        });
      }
    }
  });
}

export async function verifyGooglePlayPurchase(input: {
  userId: string;
  productId: string;
  purchaseToken: string;
}): Promise<{ active: boolean; productId: NativeStoreProductId; status: string; transactionId: string }> {
  const productId = input.productId.trim();
  const purchaseToken = input.purchaseToken.trim();
  const config = getGooglePlayBillingConfig();
  if (!isNativeStoreProductId(productId) || !config.productCatalog[productId] || !purchaseToken || purchaseToken.length > 4096) {
    throw new Error('Invalid Google Play purchase payload.');
  }
  const product = config.productCatalog[productId]!;
  await assertTokenOwnership(input.userId, purchaseToken);
  if (product.type === 'HOSTING_SUBSCRIPTION') {
    return verifyGooglePlayHostingPurchase(input.userId, purchaseToken, config);
  }
  const encodedPackage = encodeURIComponent(config.packageName);
  const encodedToken = encodeURIComponent(purchaseToken);

  if (product.type === 'SUBSCRIPTION') {
    const verified = await googlePublisherRequest<GoogleSubscriptionPurchase>(
      `/applications/${encodedPackage}/purchases/subscriptionsv2/tokens/${encodedToken}`,
    );
    const lineItem = verified.lineItems?.find((item) => item.productId === productId);
    if (!lineItem) throw new Error('Google Play returned a different subscription product.');
    const expiresAt = parseDate(lineItem.expiryTime);
    const gplayStatus = getGoogleSubscriptionStatus(verified.subscriptionState);
    const subscriptionTransactionId = getGoogleSubscriptionTransactionId(
      purchaseToken,
      verified.startTime,
      lineItem.expiryTime,
      lineItem.latestSuccessfulOrderId,
    );
    const active = ['ACTIVE', 'GRACE_PERIOD', 'CANCELLED'].includes(gplayStatus)
      && Boolean(expiresAt && expiresAt.getTime() > Date.now());
    if (!active) {
      await prisma.storePurchase.updateMany({
        where: { provider: 'GOOGLE_PLAY', purchaseToken, userId: input.userId },
        data: { status: verified.subscriptionState ?? 'UNKNOWN', expiresAt, autoRenewing: lineItem.autoRenewingPlan?.autoRenewEnabled ?? null, rawPayload: verified as Prisma.InputJsonObject, lastVerifiedAt: new Date() },
      });
      await applyVerifiedEntitlementEvent({
        userId: input.userId,
        provider: 'GOOGLE_PLAY',
        externalEventId: `google-play:${subscriptionTransactionId}:${verified.subscriptionState}:verification`,
        externalTransactionId: subscriptionTransactionId,
        eventType: 'subscription_verification',
        plan: 'PRO',
        status: gplayStatus,
        periodStart: parseDate(verified.startTime),
        periodEnd: expiresAt,
        occurredAt: new Date(),
      });
      throw new Error('The Google Play subscription is not active.');
    }

    const payment = await startPayment({
      userId: input.userId,
      provider: 'GOOGLE_PLAY',
      type: 'SUBSCRIPTION',
      amountUsd: product.amountUsd,
      providerTransactionId: subscriptionTransactionId,
      providerSubscriptionId: tokenKey(purchaseToken),
      // Google keeps the purchase token for the subscription lifetime but issues a
      // new order for renewals. Key by order so every renewal reaches the ledger.
      idempotencyKey: `google-play:${subscriptionTransactionId}`,
      metadata: { productId, store: 'google_play' },
      description: 'Mento Pro monthly subscription',
    });
    const owner = await prisma.paymentTransaction.findUnique({ where: { id: payment.id }, select: { userId: true } });
    if (owner?.userId !== input.userId) throw new Error('Purchase ownership verification failed.');
    await finalizePayment({
      transactionId: payment.id,
      provider: 'GOOGLE_PLAY',
      status: 'SUCCEEDED',
      providerTransactionId: subscriptionTransactionId,
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
        purchaseToken, transactionId: subscriptionTransactionId, originalTransactionId: tokenKey(purchaseToken),
        purchaseType: 'SUBSCRIPTION', status: verified.subscriptionState ?? 'UNKNOWN', purchasedAt: parseDate(verified.startTime),
        expiresAt, autoRenewing: lineItem.autoRenewingPlan?.autoRenewEnabled ?? null, acknowledged: true,
        environment: config.environment, rawPayload: verified as Prisma.InputJsonObject,
      },
      update: {
        userId: input.userId, paymentTransactionId: payment.id, transactionId: subscriptionTransactionId,
        status: verified.subscriptionState ?? 'UNKNOWN', expiresAt,
        autoRenewing: lineItem.autoRenewingPlan?.autoRenewEnabled ?? null, acknowledged: true,
        rawPayload: verified as Prisma.InputJsonObject, lastVerifiedAt: new Date(),
      },
    });

    await applyVerifiedEntitlementEvent({
      userId: input.userId,
      provider: 'GOOGLE_PLAY',
      externalEventId: `google-play:${subscriptionTransactionId}:${verified.subscriptionState}:verification`,
      externalTransactionId: subscriptionTransactionId,
      eventType: 'subscription_verification',
      plan: 'PRO',
      status: gplayStatus,
      periodStart: parseDate(verified.startTime),
      periodEnd: expiresAt,
      occurredAt: new Date(),
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
      acknowledged: true, consumed: true,       environment: config.environment, rawPayload: verified as Prisma.InputJsonObject,
    },
    update: { userId: input.userId, paymentTransactionId: payment.id, status: 'PURCHASED', acknowledged: true, consumed: true, rawPayload: verified as Prisma.InputJsonObject, lastVerifiedAt: new Date() },
  });
  return { active: true, productId, status: 'PURCHASED', transactionId: payment.id };
}

export const nativeStoreCatalog = PRODUCTION_PRODUCT_CATALOG;

export function getConfiguredGooglePlayHostingProductId(): NativeStoreProductId {
  return getGooglePlayBillingConfig().hostingProductId;
}

export async function cancelGooglePlaySubscriptionsForAccountDeletion(userId: string): Promise<number> {
  const config = getGooglePlayBillingConfig();
  const subscriptions = await prisma.storePurchase.findMany({
    where: { userId, provider: 'GOOGLE_PLAY', purchaseType: 'SUBSCRIPTION', status: { notIn: ['EXPIRED', 'REFUNDED', 'REVOKED', 'CANCELED_BY_USER'] } },
    select: { id: true, purchaseToken: true },
  });
  for (const subscription of subscriptions) {
    try {
      await googlePublisherRequest(
        `/applications/${encodeURIComponent(config.packageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(subscription.purchaseToken)}:cancel`,
        { method: 'POST', body: JSON.stringify({ cancellationContext: { cancellationType: 'USER_REQUESTED_STOP_RENEWALS' } }) },
      );
    } catch (error) {
      if (!isIdempotentProviderCancellationError(error)) throw error;
    }
    await prisma.storePurchase.update({ where: { id: subscription.id }, data: { autoRenewing: false, status: 'CANCELED_BY_USER', lastVerifiedAt: new Date() } });
  }
  return subscriptions.length;
}

export async function processGooglePlayRtdn(encodedData: string): Promise<{ handled: boolean; type: string }> {
  const config = getGooglePlayBillingConfig();
  const decoded = JSON.parse(Buffer.from(encodedData, 'base64').toString('utf8')) as {
    packageName?: string;
    subscriptionNotification?: { notificationType?: number; purchaseToken?: string; subscriptionId?: string };
    oneTimeProductNotification?: { notificationType?: number; purchaseToken?: string; sku?: string };
    voidedPurchaseNotification?: { purchaseToken?: string; productType?: number; refundType?: number };
  };
  if (decoded.packageName !== config.packageName) throw new Error('RTDN package name mismatch.');
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
  const voidedPurchase = decoded.voidedPurchaseNotification;
  if (voidedPurchase?.purchaseToken) {
    const existing = await prisma.storePurchase.findUnique({
      where: { provider_purchaseToken: { provider: 'GOOGLE_PLAY', purchaseToken: voidedPurchase.purchaseToken } },
    });
    if (!existing?.userId) return { handled: false, type: 'voided-purchase' };
    if (existing.productId !== config.hostingProductId) return { handled: false, type: 'voided-purchase' };
    const hostingUserId = existing.userId;
    const purchaseToken = voidedPurchase.purchaseToken;
    await prisma.$transaction(async (tx) => {
      const update = await tx.storePurchase.updateMany({
        where: { id: existing.id, status: { not: 'REFUNDED' } },
        data: { status: 'REFUNDED', lastVerifiedAt: new Date() },
      });
      if (update.count === 0) return;
      if (existing.paymentTransactionId) {
        await tx.paymentTransaction.update({
          where: { id: existing.paymentTransactionId },
          data: { status: 'REFUNDED' },
        });
      }
      await tx.websiteHostingAccount.updateMany({
        where: { userId: hostingUserId, providerPurchaseTokenHash: tokenKey(purchaseToken) },
        data: {
          tier: null,
          siteLimit: 0,
          status: 'REFUNDED',
          paidThroughAt: new Date(),
          graceDeadlineAt: new Date(),
          scheduledTier: null,
          scheduledSiteLimit: null,
          scheduledEffectiveAt: null,
          scheduledKeptWebsiteIds: Prisma.DbNull,
          lastVerifiedAt: new Date(),
        },
      });
      await tx.website.updateMany({
        where: { userId: hostingUserId, deletedAt: null, status: 'published' },
        data: { status: 'draft', publishedVersion: null, publishedDeploymentId: null, updatedAt: new Date() },
      });
      await tx.websiteDeployment.updateMany({
        where: { website: { is: { userId: hostingUserId } }, status: 'published' },
        data: { status: 'paused', unpublishedAt: new Date() },
      });
      await tx.websiteDomain.updateMany({
        where: { website: { is: { userId: hostingUserId } }, status: 'active' },
        data: { status: 'disabled' },
      });
    });
    return { handled: true, type: 'hosting-refund' };
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
        const product = isNativeStoreProductId(existing.productId)
          ? config.productCatalog[existing.productId]
          : undefined;
        const minutes = product?.type === 'TOP_UP' ? product.minutes ?? 0 : 0;
        if (minutes > 0) {
          const wallet = await tx.liveTutorWallet.findUnique({ where: { userId: existing.userId! } });
          if (wallet) {
            // Fix Phase 4B: Atomically decrement both topUpSeconds AND minutesBalance
            const refundableSeconds = Math.min(wallet.topUpSeconds, minutes * 60);
            const newTopUpSeconds = Math.max(0, wallet.topUpSeconds - refundableSeconds);
            const totalSecondsAfter = wallet.includedSeconds + newTopUpSeconds;

            const updated = await tx.liveTutorWallet.update({
              where: { userId: existing.userId! },
              data: {
                topUpSeconds: newTopUpSeconds,
                minutesBalance: Math.floor(totalSecondsAfter / 60),
              },
            });

            // Audit trail: log the refund in ledger
            await tx.liveTutorMinuteLedger.create({
              data: {
                userId: existing.userId!,
                walletId: wallet.id,
                idempotencyKey: `google-play-refund:${existing.purchaseToken}:${existing.paymentTransactionId}`,
                entryType: 'TOP_UP_REFUND',
                source: 'GOOGLE_PLAY',
                topUpSecondsDelta: -refundableSeconds,
                topUpSecondsAfter: updated.topUpSeconds,
                includedSecondsAfter: updated.includedSeconds,
              },
            });
          }
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
  return new SignedDataVerifier(appleRootCertificates(), true, environment, PRODUCTION_PACKAGE_NAME, appAppleId);
}

export async function verifyAppleStorePurchase(input: {
  userId: string;
  productId: string;
  signedTransaction: string;
}): Promise<{ active: boolean; productId: NativeStoreProductId; status: string; transactionId: string }> {
  const productId = input.productId.trim();
  const signedTransaction = input.signedTransaction.trim();
  if (!isProductionNativeStoreProductId(productId)
    || productId === PRODUCTION_HOSTING_PRODUCT_ID
    || !signedTransaction
    || signedTransaction.length > 20_000) {
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
  const product = PRODUCTION_PRODUCT_CATALOG[productId];
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
    metadata: {
      productId,
      store: 'apple_app_store',
      topUpMinutes: product.type === 'TOP_UP' ? product.minutes : undefined,
    },
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
  if (product.type === 'SUBSCRIPTION') {
    // Route Apple subscription entitlement change through canonical boundary (Phase 4B fix)
    await applyVerifiedEntitlementEvent({
      userId: input.userId,
      provider: 'APPLE_APP_STORE',
      externalEventId: `${decoded.transactionId}:verification`,
      externalTransactionId: decoded.originalTransactionId,
      eventType: 'subscription_verification',
      plan: 'PRO',
      status: 'ACTIVE',
      periodStart: decoded.purchaseDate ? new Date(decoded.purchaseDate) : new Date(),
      periodEnd: expiresAt,
      occurredAt: new Date(),
    });
  }
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
      if (revoked && isProductionNativeStoreProductId(existing.productId)) {
        const product = PRODUCTION_PRODUCT_CATALOG[existing.productId];
        const minutes = product.type === 'TOP_UP' ? product.minutes ?? 0 : 0;
        if (minutes > 0) {
          const wallet = await tx.liveTutorWallet.findUnique({ where: { userId: existing.userId! } });
          if (wallet) {
            // Fix Phase 4B: Atomically decrement both topUpSeconds AND minutesBalance
            const refundableSeconds = Math.min(wallet.topUpSeconds, minutes * 60);
            const newTopUpSeconds = Math.max(0, wallet.topUpSeconds - refundableSeconds);
            const totalSecondsAfter = wallet.includedSeconds + newTopUpSeconds;

            const updated = await tx.liveTutorWallet.update({
              where: { userId: existing.userId! },
              data: {
                topUpSeconds: newTopUpSeconds,
                minutesBalance: Math.floor(totalSecondsAfter / 60),
              },
            });

            // Audit trail: log the refund in ledger
            await tx.liveTutorMinuteLedger.create({
              data: {
                userId: existing.userId!,
                walletId: wallet.id,
                idempotencyKey: `apple-refund:${existing.transactionId}:${existing.paymentTransactionId}`,
                entryType: 'TOP_UP_REFUND',
                source: 'APPLE_APP_STORE',
                topUpSecondsDelta: -refundableSeconds,
                topUpSecondsAfter: updated.topUpSeconds,
                includedSecondsAfter: updated.includedSeconds,
              },
            });
          }
        }
      }
    });
    if (existing.purchaseType === 'SUBSCRIPTION') await removeNativeSubscriptionEntitlement(existing.userId);
    return { eventId, type, handled: true };
  }
  await verifyAppleStorePurchase({ userId: existing.userId, productId: transaction.productId, signedTransaction });
  return { eventId, type, handled: true };
}
