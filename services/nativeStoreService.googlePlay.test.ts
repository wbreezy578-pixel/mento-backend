import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const mocks = vi.hoisted(() => {
  const googleResponse = {
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    startTime: '2026-01-01T00:00:00.000Z',
    linkedPurchaseToken: undefined as string | undefined,
    lineItems: [{
      productId: 'mento_pro_monthly',
      expiryTime: '2099-01-01T00:00:00.000Z',
      latestSuccessfulOrderId: 'order-1',
      offerDetails: { basePlanId: 'sites-1' },
      autoRenewingPlan: { autoRenewEnabled: true },
    }],
  };
  const googleClient = { getAccessToken: vi.fn() };
  return {
    prisma: {
      storePurchase: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        updateMany: vi.fn(),
        upsert: vi.fn(),
      },
      websiteHostingAccount: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
        updateMany: vi.fn(),
      },
      website: { updateMany: vi.fn() },
      websiteDeployment: { updateMany: vi.fn() },
      websiteDomain: { updateMany: vi.fn() },
      $transaction: vi.fn(),
      paymentTransaction: { findUnique: vi.fn(), update: vi.fn() },
      userWallet: { update: vi.fn() },
    },
    googleResponse,
    googleClient,
    GoogleAuth: vi.fn(function GoogleAuthMock() {
      return { getClient: vi.fn(async () => googleClient) };
    }),
    getRequiredEnv: vi.fn((name: string) => {
      if (name === 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON') return '{"type":"service_account"}';
      throw new Error(`Environment variable "${name}" is required and must not be empty.`);
    }),
    startPayment: vi.fn(),
    finalizePayment: vi.fn(),
    applyVerifiedEntitlementEvent: vi.fn(),
    fetch: vi.fn(),
  };
});

vi.mock('../lib/prisma', () => ({ prisma: mocks.prisma }));
vi.mock('../lib/env', () => ({ getRequiredEnv: mocks.getRequiredEnv }));
vi.mock('google-auth-library', () => ({ GoogleAuth: mocks.GoogleAuth }));
vi.mock('./paymentService', () => ({
  startPayment: mocks.startPayment,
  finalizePayment: mocks.finalizePayment,
}));
vi.mock('./entitlementService', () => ({ applyVerifiedEntitlementEvent: mocks.applyVerifiedEntitlementEvent }));
vi.mock('./accountDeletionPolicy', () => ({ isIdempotentProviderCancellationError: vi.fn() }));

import { processGooglePlayRtdn, verifyGooglePlayPurchase } from './nativeStoreService';

const purchase = { userId: 'user-a', productId: 'mento_pro_monthly', purchaseToken: 'purchase-token-a' };
const BLUE_TEST_DATABASE_URL = 'postgresql://test:test@localhost:5432/mento_blue?host=%2Fcloudsql%2Fmento-cloud-migration%3Aus-east4%3Amento-blue-db';

function entitlementEvent() {
  const calls = mocks.applyVerifiedEntitlementEvent.mock.calls;
  return calls[calls.length - 1]?.[0] as {
    status: string;
    externalEventId: string;
    externalTransactionId?: string;
  };
}

function paymentInput() {
  return mocks.startPayment.mock.calls[mocks.startPayment.mock.calls.length - 1]?.[0] as {
    providerTransactionId?: string;
    idempotencyKey?: string;
  };
}

function setGoogleResponse(overrides: Record<string, unknown> = {}) {
  Object.assign(mocks.googleResponse, overrides);
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith(':acknowledge')) return { ok: true, status: 204, headers: new Headers() };
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => mocks.googleResponse,
    };
  });
}

function encodedRtdn(notification: Record<string, unknown>) {
  return Buffer.from(JSON.stringify({ packageName: 'com.trymentoapp.mento', ...notification })).toString('base64');
}

describe('verifyGooglePlayPurchase Google subscriptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRequiredEnv.mockImplementation((name: string) => {
      if (name === 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON') return '{"type":"service_account"}';
      throw new Error(`Environment variable "${name}" is required and must not be empty.`);
    });
    vi.stubGlobal('fetch', mocks.fetch);
    mocks.googleClient.getAccessToken.mockResolvedValue({ token: 'test-access-token' });
    mocks.prisma.storePurchase.findUnique.mockResolvedValue({ userId: purchase.userId });
    mocks.prisma.storePurchase.findFirst.mockResolvedValue({ userId: purchase.userId });
    mocks.prisma.storePurchase.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.storePurchase.upsert.mockResolvedValue({});
    mocks.prisma.websiteHostingAccount.findUnique.mockResolvedValue(null);
    mocks.prisma.websiteHostingAccount.upsert.mockResolvedValue({});
    mocks.prisma.websiteHostingAccount.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.$transaction.mockImplementation(async (callback) => callback(mocks.prisma));
    mocks.prisma.paymentTransaction.findUnique.mockResolvedValue({ userId: purchase.userId });
    mocks.prisma.paymentTransaction.update.mockResolvedValue({});
    mocks.startPayment.mockResolvedValue({ id: 'payment-a' });
    mocks.finalizePayment.mockResolvedValue(undefined);
    mocks.applyVerifiedEntitlementEvent.mockResolvedValue({ duplicate: false, stale: false });
    mocks.googleResponse.acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
    mocks.googleResponse.subscriptionState = 'SUBSCRIPTION_STATE_ACTIVE';
    mocks.googleResponse.startTime = '2026-01-01T00:00:00.000Z';
    mocks.googleResponse.linkedPurchaseToken = undefined;
    mocks.googleResponse.lineItems = [{
      productId: 'mento_pro_monthly',
      expiryTime: '2099-01-01T00:00:00.000Z',
      latestSuccessfulOrderId: 'order-1',
      autoRenewingPlan: { autoRenewEnabled: true },
    }];
    setGoogleResponse();
  });

  it('uses the Cloud Run service identity instead of explicit credentials', async () => {
    mocks.getRequiredEnv.mockImplementation((name: string) => {
      if (name === 'K_SERVICE') return 'mento-backend-migration';
      if (name === 'GOOGLE_PLAY_WIF_CONFIG_JSON') return '{malformed legacy config}';
      throw new Error(`Environment variable "${name}" is required and must not be empty.`);
    });

    await verifyGooglePlayPurchase(purchase);

    expect(mocks.GoogleAuth).toHaveBeenCalledWith({
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
  });

  it('uses the isolated Blue package and Blue-only product IDs in Blue test mode', async () => {
    mocks.getRequiredEnv.mockImplementation((name: string) => {
      if (name === 'K_SERVICE') return 'mento-backend-blue';
      if (name === 'GOOGLE_PLAY_BILLING_MODE') return 'blue-test';
      if (name === 'GOOGLE_PLAY_PACKAGE_NAME') return 'com.trymentoapp.mento.blue';
      if (name === 'DATABASE_URL' || name === 'DIRECT_URL') return BLUE_TEST_DATABASE_URL;
      throw new Error(`Environment variable "${name}" is required and must not be empty.`);
    });
    mocks.googleResponse.lineItems = [{
      productId: 'mento_blue_pro_monthly',
      expiryTime: '2099-01-01T00:00:00.000Z',
      latestSuccessfulOrderId: 'blue-order-1',
      autoRenewingPlan: { autoRenewEnabled: true },
    }];

    const result = await verifyGooglePlayPurchase({
      ...purchase,
      productId: 'mento_blue_pro_monthly',
    });

    expect(result.active).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/applications/com.trymentoapp.mento.blue/purchases/subscriptionsv2/tokens/'),
      expect.any(Object),
    );
    expect(mocks.startPayment).toHaveBeenCalledWith(expect.objectContaining({
      providerTransactionId: 'blue-order-1',
      metadata: expect.objectContaining({ productId: 'mento_blue_pro_monthly' }),
    }));
    expect(mocks.prisma.storePurchase.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ productId: 'mento_blue_pro_monthly', environment: 'TEST' }),
    }));
  });

  it('fails closed on the Blue service when Blue test billing mode is missing', async () => {
    mocks.getRequiredEnv.mockImplementation((name: string) => {
      if (name === 'K_SERVICE') return 'mento-backend-blue';
      throw new Error(`Environment variable "${name}" is required and must not be empty.`);
    });

    await expect(verifyGooglePlayPurchase(purchase)).rejects.toThrow(
      'Google Play billing is disabled on Blue until its isolated test configuration is enabled.',
    );
    expect(mocks.GoogleAuth).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('rejects Green product IDs in Blue test mode', async () => {
    mocks.getRequiredEnv.mockImplementation((name: string) => {
      if (name === 'K_SERVICE') return 'mento-backend-blue';
      if (name === 'GOOGLE_PLAY_BILLING_MODE') return 'blue-test';
      if (name === 'GOOGLE_PLAY_PACKAGE_NAME') return 'com.trymentoapp.mento.blue';
      if (name === 'DATABASE_URL' || name === 'DIRECT_URL') return BLUE_TEST_DATABASE_URL;
      throw new Error(`Environment variable "${name}" is required and must not be empty.`);
    });

    await expect(verifyGooglePlayPurchase(purchase)).rejects.toThrow('Invalid Google Play purchase payload.');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('rejects the production package configured for Blue test mode', async () => {
    mocks.getRequiredEnv.mockImplementation((name: string) => {
      if (name === 'K_SERVICE') return 'mento-backend-blue';
      if (name === 'GOOGLE_PLAY_BILLING_MODE') return 'blue-test';
      if (name === 'GOOGLE_PLAY_PACKAGE_NAME') return 'com.trymentoapp.mento';
      throw new Error(`Environment variable "${name}" is required and must not be empty.`);
    });

    await expect(verifyGooglePlayPurchase({
      ...purchase,
      productId: 'mento_blue_pro_monthly',
    })).rejects.toThrow('Blue Google Play billing requires the dedicated Blue test package.');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('rejects production database URLs in Blue test mode', async () => {
    mocks.getRequiredEnv.mockImplementation((name: string) => {
      if (name === 'K_SERVICE') return 'mento-backend-blue';
      if (name === 'GOOGLE_PLAY_BILLING_MODE') return 'blue-test';
      if (name === 'GOOGLE_PLAY_PACKAGE_NAME') return 'com.trymentoapp.mento.blue';
      if (name === 'DATABASE_URL' || name === 'DIRECT_URL') return 'postgresql://test:test@db.example.test:5432/production';
      throw new Error(`Environment variable "${name}" is required and must not be empty.`);
    });

    await expect(verifyGooglePlayPurchase({
      ...purchase,
      productId: 'mento_blue_pro_monthly',
    })).rejects.toThrow('Blue test billing requires both database URLs to use the isolated Blue database.');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('rejects Blue test mode on the production Cloud Run service', async () => {
    mocks.getRequiredEnv.mockImplementation((name: string) => {
      if (name === 'K_SERVICE') return 'mento-backend-migration';
      if (name === 'GOOGLE_PLAY_BILLING_MODE') return 'blue-test';
      if (name === 'GOOGLE_PLAY_PACKAGE_NAME') return 'com.trymentoapp.mento.blue';
      throw new Error(`Environment variable "${name}" is required and must not be empty.`);
    });

    await expect(verifyGooglePlayPurchase({
      ...purchase,
      productId: 'mento_blue_pro_monthly',
    })).rejects.toThrow('Blue test billing cannot be enabled on the production service.');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('falls back to service-account configuration when WIF is absent', async () => {
    await verifyGooglePlayPurchase(purchase);

    expect(mocks.GoogleAuth).toHaveBeenCalledWith(expect.objectContaining({
      credentials: { type: 'service_account' },
    }));
  });

  it('fails closed when neither credential method is configured', async () => {
    mocks.getRequiredEnv.mockImplementation((name: string) => {
      throw new Error(`Environment variable "${name}" is required and must not be empty.`);
    });

    await expect(verifyGooglePlayPurchase(purchase)).rejects.toThrow(
      'Google Play authentication is not configured. Set GOOGLE_PLAY_SERVICE_ACCOUNT_JSON.',
    );
    expect(mocks.GoogleAuth).not.toHaveBeenCalled();
  });

  it('rejects malformed service-account JSON without contacting Google Auth', async () => {
    mocks.getRequiredEnv.mockImplementation((name: string) => {
      if (name === 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON') return '{malformed';
      throw new Error(`Environment variable "${name}" is required and must not be empty.`);
    });

    await expect(verifyGooglePlayPurchase(purchase)).rejects.toThrow(
      'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not valid Google Auth configuration JSON.',
    );
    expect(mocks.GoogleAuth).not.toHaveBeenCalled();
  });

  it('verifies an initial active purchase and records its order identity', async () => {
    const result = await verifyGooglePlayPurchase(purchase);

    expect(result.active).toBe(true);
    expect(paymentInput()).toMatchObject({ providerTransactionId: 'order-1', idempotencyKey: 'google-play:order-1' });
    expect(mocks.finalizePayment).toHaveBeenCalledWith(expect.objectContaining({ providerTransactionId: 'order-1' }));
    expect(entitlementEvent()).toMatchObject({
      status: 'ACTIVE',
      externalTransactionId: 'order-1',
      externalEventId: expect.stringContaining('google-play:order-1:SUBSCRIPTION_STATE_ACTIVE:verification'),
    });
    expect(mocks.prisma.storePurchase.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ transactionId: 'order-1' }),
      update: expect.objectContaining({ transactionId: 'order-1' }),
    }));
    expect(mocks.prisma.websiteHostingAccount.upsert).not.toHaveBeenCalled();
    expect(mocks.prisma.websiteHostingAccount.updateMany).not.toHaveBeenCalled();
  });

  it('creates a distinct canonical event for a renewal with the same token', async () => {
    await verifyGooglePlayPurchase(purchase);
    const firstEventId = entitlementEvent().externalEventId;

    mocks.googleResponse.lineItems = [{
      productId: 'mento_pro_monthly',
      expiryTime: '2099-02-01T00:00:00.000Z',
      latestSuccessfulOrderId: 'order-2',
    }];
    await verifyGooglePlayPurchase(purchase);

    expect(paymentInput()).toMatchObject({ providerTransactionId: 'order-2', idempotencyKey: 'google-play:order-2' });
    expect(entitlementEvent()).toMatchObject({ externalTransactionId: 'order-2' });
    expect(entitlementEvent().externalEventId).toContain('order-2');
    expect(entitlementEvent().externalEventId).not.toBe(firstEventId);
  });

  it('keeps an exact order and state verification idempotent', async () => {
    await verifyGooglePlayPurchase(purchase);
    const firstEventId = entitlementEvent().externalEventId;
    await verifyGooglePlayPurchase(purchase);

    expect(entitlementEvent().externalEventId).toBe(firstEventId);
    expect(entitlementEvent().externalEventId).not.toContain(new Date().toISOString());
  });

  it.each([
    ['SUBSCRIPTION_STATE_CANCELED', 'CANCELLED', true],
    ['SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'GRACE_PERIOD', true],
  ])('keeps %s active through its valid future period', async (googleState, canonicalStatus, active) => {
    mocks.googleResponse.subscriptionState = googleState;

    const result = await verifyGooglePlayPurchase(purchase);

    expect(result.active).toBe(active);
    expect(entitlementEvent()).toMatchObject({ status: canonicalStatus });
  });

  it.each([
    ['SUBSCRIPTION_STATE_ON_HOLD', 'ON_HOLD', 'The Google Play subscription is not active.'],
    ['SUBSCRIPTION_STATE_PAUSED', 'ON_HOLD', 'The Google Play subscription is not active.'],
    ['SUBSCRIPTION_STATE_EXPIRED', 'EXPIRED', 'The Google Play subscription is not active.'],
  ])('routes %s through canonical removal handling', async (googleState, canonicalStatus, message) => {
    mocks.googleResponse.subscriptionState = googleState;
    if (googleState === 'SUBSCRIPTION_STATE_EXPIRED') {
      mocks.googleResponse.lineItems = [{ productId: 'mento_pro_monthly', expiryTime: '2020-01-01T00:00:00.000Z', latestSuccessfulOrderId: 'order-1' }];
    }

    await expect(verifyGooglePlayPurchase(purchase)).rejects.toThrow(message);
    expect(entitlementEvent()).toMatchObject({ status: canonicalStatus });
    expect(mocks.prisma.userWallet.update).not.toHaveBeenCalled();
    expect(mocks.startPayment).not.toHaveBeenCalled();
  });

  it('fails closed for an unknown state without granting or charging', async () => {
    mocks.googleResponse.subscriptionState = 'SUBSCRIPTION_STATE_UNSUPPORTED';

    await expect(verifyGooglePlayPurchase(purchase)).rejects.toThrow('unknown subscription state');

    expect(mocks.applyVerifiedEntitlementEvent).not.toHaveBeenCalled();
    expect(mocks.startPayment).not.toHaveBeenCalled();
    expect(mocks.finalizePayment).not.toHaveBeenCalled();
  });

  it('acknowledges a pending active subscription', async () => {
    mocks.googleResponse.acknowledgementState = 'ACKNOWLEDGEMENT_STATE_PENDING';

    await verifyGooglePlayPurchase(purchase);

    expect(mocks.fetch).toHaveBeenCalledWith(expect.stringContaining(':acknowledge'), expect.objectContaining({ method: 'POST' }));
  });

  it('does not acknowledge an already acknowledged subscription', async () => {
    await verifyGooglePlayPurchase(purchase);

    expect(mocks.fetch).not.toHaveBeenCalledWith(expect.stringContaining(':acknowledge'), expect.anything());
  });

  it('uses a deterministic token-and-period fallback when no order is returned', async () => {
    mocks.googleResponse.lineItems = [{ productId: 'mento_pro_monthly', expiryTime: '2099-01-01T00:00:00.000Z' }];
    await verifyGooglePlayPurchase(purchase);
    const firstTransactionId = paymentInput().providerTransactionId;
    const firstEventId = entitlementEvent().externalEventId;

    await verifyGooglePlayPurchase(purchase);
    expect(paymentInput().providerTransactionId).toBe(firstTransactionId);
    expect(entitlementEvent().externalEventId).toBe(firstEventId);
    expect(firstTransactionId).toMatch(/^google-play-period:[a-f0-9]+:[a-f0-9]+$/);
    expect(firstTransactionId).not.toContain('2026');

    mocks.googleResponse.lineItems = [{ productId: 'mento_pro_monthly', expiryTime: '2099-02-01T00:00:00.000Z' }];
    await verifyGooglePlayPurchase(purchase);
    expect(paymentInput().providerTransactionId).not.toBe(firstTransactionId);
  });

  it('verifies hosting separately and only updates hosting entitlement state', async () => {
    mocks.googleResponse.lineItems = [{
      productId: 'mento_hosting_slot',
      expiryTime: '2099-01-01T00:00:00.000Z',
      latestSuccessfulOrderId: 'hosting-order-1',
      offerDetails: { basePlanId: 'sites-3' },
      autoRenewingPlan: { autoRenewEnabled: true },
    }];

    const result = await verifyGooglePlayPurchase({
      userId: 'user-a',
      productId: 'mento_hosting_slot',
      purchaseToken: 'hosting-token-a',
    });

    expect(result).toMatchObject({
      active: true,
      productId: 'mento_hosting_slot',
      status: 'SUBSCRIPTION_STATE_ACTIVE',
      transactionId: 'hosting-order-1',
    });
    expect(mocks.prisma.websiteHostingAccount.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-a' },
      create: expect.objectContaining({
        tier: 'SITES_3',
        siteLimit: 3,
        provider: 'GOOGLE_PLAY',
        providerProductId: 'mento_hosting_slot',
        providerPurchaseTokenHash: expect.any(String),
        paidThroughAt: new Date('2099-01-01T00:00:00.000Z'),
      }),
      update: expect.objectContaining({ status: 'ACTIVE', tier: 'SITES_3', siteLimit: 3 }),
    }));
    expect(mocks.prisma.storePurchase.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        userId: 'user-a',
        productId: 'mento_hosting_slot',
        purchaseType: 'SUBSCRIPTION',
        transactionId: 'hosting-order-1',
      }),
    }));
    expect(mocks.applyVerifiedEntitlementEvent).not.toHaveBeenCalled();
    expect(mocks.startPayment).not.toHaveBeenCalled();
    expect(mocks.finalizePayment).not.toHaveBeenCalled();
  });

  it('uses a Blue-only hosting product and package in Blue test mode', async () => {
    mocks.getRequiredEnv.mockImplementation((name: string) => {
      if (name === 'K_SERVICE') return 'mento-backend-blue';
      if (name === 'GOOGLE_PLAY_BILLING_MODE') return 'blue-test';
      if (name === 'GOOGLE_PLAY_PACKAGE_NAME') return 'com.trymentoapp.mento.blue';
      if (name === 'DATABASE_URL' || name === 'DIRECT_URL') return BLUE_TEST_DATABASE_URL;
      throw new Error(`Environment variable "${name}" is required and must not be empty.`);
    });
    mocks.googleResponse.lineItems = [{
      productId: 'mento_blue_hosting_slot',
      expiryTime: '2099-01-01T00:00:00.000Z',
      latestSuccessfulOrderId: 'blue-hosting-order-1',
      offerDetails: { basePlanId: 'sites-3' },
    }];

    const result = await verifyGooglePlayPurchase({
      userId: 'user-a',
      productId: 'mento_blue_hosting_slot',
      purchaseToken: 'blue-hosting-token-a',
    });

    expect(result).toMatchObject({ active: true, productId: 'mento_blue_hosting_slot' });
    expect(mocks.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/applications/com.trymentoapp.mento.blue/purchases/subscriptionsv2/tokens/'),
      expect.any(Object),
    );
    expect(mocks.prisma.websiteHostingAccount.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        tier: 'SITES_3',
        siteLimit: 3,
        providerProductId: 'mento_blue_hosting_slot',
      }),
    }));
    expect(mocks.prisma.storePurchase.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ productId: 'mento_blue_hosting_slot', environment: 'TEST' }),
    }));
  });

  it('acknowledges a verified hosting subscription without activating Pro', async () => {
    mocks.googleResponse.acknowledgementState = 'ACKNOWLEDGEMENT_STATE_PENDING';
    mocks.googleResponse.lineItems = [{
      productId: 'mento_hosting_slot',
      expiryTime: '2099-01-01T00:00:00.000Z',
      latestSuccessfulOrderId: 'hosting-order-1',
      offerDetails: { basePlanId: 'sites-1' },
    }];

    await verifyGooglePlayPurchase({
      userId: 'user-a',
      productId: 'mento_hosting_slot',
      purchaseToken: 'hosting-token-a',
    });

    expect(mocks.fetch).toHaveBeenCalledWith(expect.stringContaining('/subscriptions/mento_hosting_slot/tokens/'), expect.objectContaining({ method: 'POST' }));
    expect(mocks.applyVerifiedEntitlementEvent).not.toHaveBeenCalled();
    expect(mocks.prisma.userWallet.update).not.toHaveBeenCalled();
  });

  it('rejects unknown hosting base plans without granting hosting capacity', async () => {
    mocks.googleResponse.lineItems = [{
      productId: 'mento_hosting_slot',
      expiryTime: '2099-01-01T00:00:00.000Z',
      offerDetails: { basePlanId: 'unrecognized-tier' },
    }];

    await expect(verifyGooglePlayPurchase({
      userId: 'user-a',
      productId: 'mento_hosting_slot',
      purchaseToken: 'hosting-token-a',
    })).rejects.toThrow('unsupported website hosting tier');

    expect(mocks.prisma.websiteHostingAccount.upsert).not.toHaveBeenCalled();
    expect(mocks.prisma.storePurchase.upsert).not.toHaveBeenCalled();
    expect(mocks.applyVerifiedEntitlementEvent).not.toHaveBeenCalled();
  });

  it('records inactive hosting subscription status without touching Pro entitlement', async () => {
    mocks.googleResponse.subscriptionState = 'SUBSCRIPTION_STATE_ON_HOLD';
    mocks.googleResponse.lineItems = [{
      productId: 'mento_hosting_slot',
      expiryTime: '2099-01-01T00:00:00.000Z',
      offerDetails: { basePlanId: 'sites-1' },
    }];

    const result = await verifyGooglePlayPurchase({
      userId: 'user-a',
      productId: 'mento_hosting_slot',
      purchaseToken: 'hosting-token-a',
    });

    expect(result.active).toBe(false);
    expect(mocks.prisma.websiteHostingAccount.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ status: 'ON_HOLD' }),
    }));
    expect(mocks.applyVerifiedEntitlementEvent).not.toHaveBeenCalled();
    expect(mocks.startPayment).not.toHaveBeenCalled();
  });

  it('rejects a hosting token already associated with another account', async () => {
    mocks.prisma.storePurchase.findUnique.mockResolvedValue({ userId: 'user-b' });

    await expect(verifyGooglePlayPurchase({
      userId: 'user-a',
      productId: 'mento_hosting_slot',
      purchaseToken: 'hosting-token-a',
    })).rejects.toThrow('already associated with another account');

    expect(mocks.prisma.websiteHostingAccount.upsert).not.toHaveBeenCalled();
    expect(mocks.applyVerifiedEntitlementEvent).not.toHaveBeenCalled();
  });

  it('does not overwrite another active hosting subscription on the same account', async () => {
    mocks.googleResponse.lineItems = [{
      productId: 'mento_hosting_slot',
      expiryTime: '2099-01-01T00:00:00.000Z',
      offerDetails: { basePlanId: 'sites-1' },
    }];
    mocks.prisma.websiteHostingAccount.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        providerPurchaseTokenHash: 'existing-token-hash',
        status: 'ACTIVE',
        paidThroughAt: new Date('2099-01-01T00:00:00.000Z'),
      });

    await expect(verifyGooglePlayPurchase({
      userId: 'user-a',
      productId: 'mento_hosting_slot',
      purchaseToken: 'hosting-token-a',
    })).rejects.toThrow('already has an active Google Play hosting subscription');

    expect(mocks.prisma.websiteHostingAccount.upsert).not.toHaveBeenCalled();
    expect(mocks.prisma.storePurchase.upsert).not.toHaveBeenCalled();
    expect(mocks.applyVerifiedEntitlementEvent).not.toHaveBeenCalled();
  });

  it('accepts a Google-verified replacement token linked to this account when changing tiers', async () => {
    const previousPurchaseToken = 'previous-hosting-token';
    mocks.googleResponse.lineItems = [{
      productId: 'mento_hosting_slot',
      expiryTime: '2099-01-01T00:00:00.000Z',
      offerDetails: { basePlanId: 'sites-5' },
    }];
    mocks.googleResponse.linkedPurchaseToken = previousPurchaseToken;
    mocks.prisma.websiteHostingAccount.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        providerPurchaseTokenHash: createHash('sha256').update(previousPurchaseToken).digest('hex'),
        status: 'ACTIVE',
        paidThroughAt: new Date('2099-01-01T00:00:00.000Z'),
      });

    await verifyGooglePlayPurchase({
      userId: 'user-a',
      productId: 'mento_hosting_slot',
      purchaseToken: 'replacement-hosting-token',
    });

    expect(mocks.prisma.websiteHostingAccount.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-a' },
      update: expect.objectContaining({ tier: 'SITES_5', siteLimit: 5 }),
    }));
  });

  it.each([
    ['renewal', 2, 'SUBSCRIPTION_STATE_ACTIVE'],
    ['cancellation', 3, 'SUBSCRIPTION_STATE_CANCELED'],
    ['payment hold', 5, 'SUBSCRIPTION_STATE_ON_HOLD'],
  ])('processes a hosting %s only from the current Google subscription state', async (_name, notificationType, state) => {
    mocks.prisma.storePurchase.findUnique.mockResolvedValue({
      id: 'hosting-purchase',
      userId: 'user-a',
      productId: 'mento_hosting_slot',
      purchaseToken: 'hosting-rtdn-token',
    });

    mocks.googleResponse.subscriptionState = state as string;
    mocks.googleResponse.lineItems = [{
      productId: 'mento_hosting_slot',
      expiryTime: '2099-01-01T00:00:00.000Z',
      latestSuccessfulOrderId: `hosting-order-${notificationType}`,
      offerDetails: { basePlanId: 'sites-3' },
    }];

    const result = await processGooglePlayRtdn(encodedRtdn({
      subscriptionNotification: {
        notificationType,
        purchaseToken: 'hosting-rtdn-token',
        subscriptionId: 'mento_hosting_slot',
      },
    }));

    expect(result).toEqual({ handled: true, type: `subscription:${notificationType}` });
    expect(mocks.prisma.websiteHostingAccount.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        status: state === 'SUBSCRIPTION_STATE_CANCELED'
          ? 'CANCELLED'
          : state === 'SUBSCRIPTION_STATE_ON_HOLD' ? 'ON_HOLD' : 'ACTIVE',
        tier: 'SITES_3',
        siteLimit: 3,
        graceDeadlineAt: state === 'SUBSCRIPTION_STATE_ON_HOLD' ? expect.any(Date) : null,
      }),
    }));
    if (state === 'SUBSCRIPTION_STATE_ON_HOLD') {
      expect(mocks.prisma.websiteHostingAccount.upsert).toHaveBeenCalledWith(expect.objectContaining({
        update: expect.objectContaining({ paidThroughAt: new Date('2099-01-01T00:00:00.000Z') }),
      }));
    }
    expect(mocks.applyVerifiedEntitlementEvent).not.toHaveBeenCalled();
    expect(mocks.prisma.userWallet.update).not.toHaveBeenCalled();
  });

  it('rejects production-package RTDN notifications on the Blue service', async () => {
    mocks.getRequiredEnv.mockImplementation((name: string) => {
      if (name === 'K_SERVICE') return 'mento-backend-blue';
      if (name === 'GOOGLE_PLAY_BILLING_MODE') return 'blue-test';
      if (name === 'GOOGLE_PLAY_PACKAGE_NAME') return 'com.trymentoapp.mento.blue';
      if (name === 'DATABASE_URL' || name === 'DIRECT_URL') return BLUE_TEST_DATABASE_URL;
      throw new Error(`Environment variable "${name}" is required and must not be empty.`);
    });

    await expect(processGooglePlayRtdn(encodedRtdn({
      subscriptionNotification: {
        notificationType: 2,
        purchaseToken: 'green-rtdn-token',
        subscriptionId: 'mento_pro_monthly',
      },
    }))).rejects.toThrow('RTDN package name mismatch.');
    expect(mocks.prisma.storePurchase.findUnique).not.toHaveBeenCalled();
  });

  it('revokes only hosting state when Google sends a voided hosting purchase', async () => {
    mocks.prisma.storePurchase.findUnique.mockResolvedValue({
      id: 'hosting-purchase',
      userId: 'user-a',
      productId: 'mento_hosting_slot',
      purchaseToken: 'hosting-refund-token',
      paymentTransactionId: 'hosting-payment',
    });

    const result = await processGooglePlayRtdn(encodedRtdn({
      voidedPurchaseNotification: { purchaseToken: 'hosting-refund-token', productType: 1, refundType: 1 },
    }));

    expect(result).toEqual({ handled: true, type: 'hosting-refund' });
    expect(mocks.prisma.storePurchase.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'hosting-purchase', status: { not: 'REFUNDED' } },
      data: expect.objectContaining({ status: 'REFUNDED' }),
    }));
    expect(mocks.prisma.websiteHostingAccount.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: 'user-a', providerPurchaseTokenHash: expect.any(String) }),
      data: expect.objectContaining({ tier: null, siteLimit: 0, status: 'REFUNDED' }),
    }));
    expect(mocks.prisma.website.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-a', deletedAt: null, status: 'published' },
      data: expect.objectContaining({ status: 'draft', publishedVersion: null, publishedDeploymentId: null }),
    }));
    expect(mocks.prisma.websiteDeployment.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { website: { is: { userId: 'user-a' } }, status: 'published' },
      data: expect.objectContaining({ status: 'paused' }),
    }));
    expect(mocks.prisma.websiteDomain.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { website: { is: { userId: 'user-a' } }, status: 'active' },
      data: { status: 'disabled' },
    }));
    expect(mocks.prisma.paymentTransaction.update).toHaveBeenCalledWith({
      where: { id: 'hosting-payment' },
      data: { status: 'REFUNDED' },
    });
    expect(mocks.applyVerifiedEntitlementEvent).not.toHaveBeenCalled();
    expect(mocks.prisma.userWallet.update).not.toHaveBeenCalled();
  });

  it('does not reapply a duplicate hosting refund', async () => {
    mocks.prisma.storePurchase.findUnique.mockResolvedValue({
      id: 'hosting-purchase',
      userId: 'user-a',
      productId: 'mento_hosting_slot',
      purchaseToken: 'hosting-refund-token',
      paymentTransactionId: 'hosting-payment',
    });
    mocks.prisma.storePurchase.updateMany.mockResolvedValueOnce({ count: 0 });

    await processGooglePlayRtdn(encodedRtdn({
      voidedPurchaseNotification: { purchaseToken: 'hosting-refund-token', productType: 1, refundType: 1 },
    }));

    expect(mocks.prisma.websiteHostingAccount.updateMany).not.toHaveBeenCalled();
    expect(mocks.prisma.paymentTransaction.update).not.toHaveBeenCalled();
  });

  it('keeps Pro renewal RTDN on the existing Pro entitlement path', async () => {
    mocks.prisma.storePurchase.findUnique.mockResolvedValue({
      id: 'pro-purchase',
      userId: 'user-a',
      productId: 'mento_pro_monthly',
      purchaseToken: 'pro-rtdn-token',
    });

    const result = await processGooglePlayRtdn(encodedRtdn({
      subscriptionNotification: {
        notificationType: 2,
        purchaseToken: 'pro-rtdn-token',
        subscriptionId: 'mento_pro_monthly',
      },
    }));

    expect(result).toEqual({ handled: true, type: 'subscription:2' });
    expect(mocks.applyVerifiedEntitlementEvent).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-a',
      plan: 'PRO',
      status: 'ACTIVE',
    }));
    expect(mocks.prisma.websiteHostingAccount.upsert).not.toHaveBeenCalled();
  });

  it('does not route non-hosting voided purchases through hosting refund handling', async () => {
    mocks.prisma.storePurchase.findUnique.mockResolvedValue({
      id: 'pro-purchase',
      userId: 'user-a',
      productId: 'mento_pro_monthly',
      purchaseToken: 'pro-refund-token',
    });

    const result = await processGooglePlayRtdn(encodedRtdn({
      voidedPurchaseNotification: { purchaseToken: 'pro-refund-token', productType: 1, refundType: 1 },
    }));

    expect(result).toEqual({ handled: false, type: 'voided-purchase' });
    expect(mocks.prisma.websiteHostingAccount.updateMany).not.toHaveBeenCalled();
    expect(mocks.prisma.website.updateMany).not.toHaveBeenCalled();
    expect(mocks.prisma.userWallet.update).not.toHaveBeenCalled();
  });
});
