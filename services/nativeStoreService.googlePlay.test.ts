import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const googleResponse = {
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    startTime: '2026-01-01T00:00:00.000Z',
    lineItems: [{
      productId: 'mento_pro_monthly',
      expiryTime: '2099-01-01T00:00:00.000Z',
      latestSuccessfulOrderId: 'order-1',
      autoRenewingPlan: { autoRenewEnabled: true },
    }],
  };
  const googleClient = { getAccessToken: vi.fn() };
  return {
    prisma: {
      storePurchase: {
        findUnique: vi.fn(),
        updateMany: vi.fn(),
        upsert: vi.fn(),
      },
      paymentTransaction: { findUnique: vi.fn() },
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

import { verifyGooglePlayPurchase } from './nativeStoreService';

const purchase = { userId: 'user-a', productId: 'mento_pro_monthly', purchaseToken: 'purchase-token-a' };

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
    mocks.prisma.storePurchase.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.storePurchase.upsert.mockResolvedValue({});
    mocks.prisma.paymentTransaction.findUnique.mockResolvedValue({ userId: purchase.userId });
    mocks.startPayment.mockResolvedValue({ id: 'payment-a' });
    mocks.finalizePayment.mockResolvedValue(undefined);
    mocks.applyVerifiedEntitlementEvent.mockResolvedValue({ duplicate: false, stale: false });
    mocks.googleResponse.acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
    mocks.googleResponse.subscriptionState = 'SUBSCRIPTION_STATE_ACTIVE';
    mocks.googleResponse.startTime = '2026-01-01T00:00:00.000Z';
    mocks.googleResponse.lineItems = [{
      productId: 'mento_pro_monthly',
      expiryTime: '2099-01-01T00:00:00.000Z',
      latestSuccessfulOrderId: 'order-1',
      autoRenewingPlan: { autoRenewEnabled: true },
    }];
    setGoogleResponse();
  });

  it('selects WIF configuration when present', async () => {
    mocks.getRequiredEnv.mockImplementation((name: string) => {
      if (name === 'GOOGLE_PLAY_WIF_CONFIG_JSON') return '{"type":"external_account","audience":"test"}';
      if (name === 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON') return '{"type":"service_account"}';
      throw new Error(`Environment variable "${name}" is required and must not be empty.`);
    });

    await verifyGooglePlayPurchase(purchase);

    expect(mocks.GoogleAuth).toHaveBeenCalledWith(expect.objectContaining({
      credentials: { type: 'external_account', audience: 'test' },
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    }));
  });

  it('uses the Container Apps identity endpoint for the Azure WIF subject token', async () => {
    const wifConfig = {
      type: 'external_account',
      audience: 'test',
      credential_source: {
        url: 'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=api%3A%2F%2Fgoogle-wif-app',
        headers: { Metadata: 'True' },
        format: { type: 'json', subject_token_field_name: 'access_token' },
      },
    };
    mocks.getRequiredEnv.mockImplementation((name: string) => {
      if (name === 'GOOGLE_PLAY_WIF_CONFIG_JSON') return JSON.stringify(wifConfig);
      if (name === 'IDENTITY_ENDPOINT') return 'http://localhost:42356/msi/token';
      if (name === 'IDENTITY_HEADER') return 'container-apps-secret-header';
      throw new Error(`Environment variable "${name}" is required and must not be empty.`);
    });

    await verifyGooglePlayPurchase(purchase);

    expect(mocks.GoogleAuth).toHaveBeenCalledWith(expect.objectContaining({
      credentials: expect.objectContaining({
        type: 'external_account',
        audience: 'test',
        credential_source: {
          url: 'http://localhost:42356/msi/token?resource=api%3A%2F%2Fgoogle-wif-app&api-version=2019-08-01',
          headers: { 'X-IDENTITY-HEADER': 'container-apps-secret-header' },
          format: { type: 'json', subject_token_field_name: 'access_token' },
        },
      }),
    }));
  });

  it('fails closed when Container Apps identity variables are incomplete', async () => {
    mocks.getRequiredEnv.mockImplementation((name: string) => {
      if (name === 'GOOGLE_PLAY_WIF_CONFIG_JSON') return JSON.stringify({
        type: 'external_account',
        credential_source: {
          url: 'http://169.254.169.254/metadata/identity/oauth2/token?resource=api%3A%2F%2Fgoogle-wif-app',
        },
      });
      if (name === 'IDENTITY_ENDPOINT') return 'http://localhost:42356/msi/token';
      throw new Error(`Environment variable "${name}" is required and must not be empty.`);
    });

    await expect(verifyGooglePlayPurchase(purchase)).rejects.toThrow(
      'Azure Container Apps managed identity is incompletely configured.',
    );
    expect(mocks.GoogleAuth).not.toHaveBeenCalled();
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
      'Google Play authentication is not configured. Set GOOGLE_PLAY_WIF_CONFIG_JSON or GOOGLE_PLAY_SERVICE_ACCOUNT_JSON.',
    );
    expect(mocks.GoogleAuth).not.toHaveBeenCalled();
  });

  it('rejects malformed WIF JSON without contacting Google Auth', async () => {
    mocks.getRequiredEnv.mockImplementation((name: string) => {
      if (name === 'GOOGLE_PLAY_WIF_CONFIG_JSON') return '{malformed';
      throw new Error(`Environment variable "${name}" is required and must not be empty.`);
    });

    await expect(verifyGooglePlayPurchase(purchase)).rejects.toThrow(
      'GOOGLE_PLAY_WIF_CONFIG_JSON is not valid Google Auth configuration JSON.',
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
});
