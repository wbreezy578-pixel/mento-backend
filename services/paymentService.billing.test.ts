import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const tx = {
    paymentTransaction: {
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    liveTutorWallet: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    liveTutorMinuteLedger: { create: vi.fn() },
    paymentLedgerEntry: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    paymentReceipt: { upsert: vi.fn() },
  };

  return {
    tx,
    prisma: {
      paymentTransaction: { findUnique: vi.fn() },
      paymentReceipt: { findUnique: vi.fn() },
      $transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
    },
    ensureUserBillingSetup: vi.fn(),
    ensureDefaultPlans: vi.fn(),
    observeMonitoringLatency: vi.fn(),
    incrementMonitoringFailure: vi.fn(),
    trackShutdownOperation: vi.fn((operation: Promise<unknown>) => operation),
    logger: { warn: vi.fn(), info: vi.fn() },
  };
});

vi.mock('../lib/prisma', () => ({ prisma: mocks.prisma }));
vi.mock('./economicsService', () => ({ ensureUserBillingSetup: mocks.ensureUserBillingSetup }));
vi.mock('./planService', () => ({ ensureDefaultPlans: mocks.ensureDefaultPlans }));
vi.mock('../lib/monitoring', () => ({
  observeMonitoringLatency: mocks.observeMonitoringLatency,
  incrementMonitoringFailure: mocks.incrementMonitoringFailure,
}));
vi.mock('../lib/crashRecovery', () => ({ trackShutdownOperation: mocks.trackShutdownOperation }));
vi.mock('../lib/logger', () => ({ default: mocks.logger }));
vi.mock('../lib/metrics', () => ({}));

import { finalizePayment } from './paymentService';

const BASE_PAYMENT = {
  id: 'payment-1',
  userId: 'user-pro',
  provider: 'GOOGLE_PLAY',
  type: 'TOP_UP',
  status: 'PENDING',
  currency: 'USD',
  amountUsd: 10,
  amountMinor: 1000,
  metadata: { topUpMinutes: 50 },
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

function configurePayment(type: 'TOP_UP' | 'SUBSCRIPTION') {
  const pending = { ...BASE_PAYMENT, type, metadata: type === 'TOP_UP' ? { topUpMinutes: 50 } : {} };
  const succeeded = { ...pending, status: 'SUCCEEDED' };
  mocks.prisma.paymentTransaction.findUnique.mockResolvedValue(pending);
  mocks.tx.paymentTransaction.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.paymentTransaction.findUniqueOrThrow.mockResolvedValue(succeeded);
  mocks.tx.paymentTransaction.update.mockResolvedValue(succeeded);
  mocks.tx.liveTutorWallet.findUnique.mockResolvedValue({
    id: 'live-wallet-1',
    includedSeconds: 3600,
    topUpSeconds: 0,
  });
  mocks.tx.liveTutorWallet.update.mockResolvedValue({
    id: 'live-wallet-1',
    includedSeconds: 3600,
    topUpSeconds: type === 'TOP_UP' ? 3000 : 0,
  });
  mocks.tx.liveTutorMinuteLedger.create.mockResolvedValue({});
  mocks.tx.paymentLedgerEntry.findFirst.mockResolvedValue(null);
  mocks.tx.paymentLedgerEntry.create.mockResolvedValue({});
  mocks.tx.paymentReceipt.upsert.mockResolvedValue({});
  mocks.prisma.paymentReceipt.findUnique.mockResolvedValue(null);
  mocks.ensureUserBillingSetup.mockResolvedValue(undefined);
  mocks.ensureDefaultPlans.mockResolvedValue(undefined);
}

describe('payment finalization entitlement boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('credits a top-up without changing the existing Pro entitlement', async () => {
    configurePayment('TOP_UP');

    await finalizePayment({
      transactionId: BASE_PAYMENT.id,
      provider: 'GOOGLE_PLAY',
      status: 'SUCCEEDED',
    });

    expect(mocks.ensureUserBillingSetup).toHaveBeenCalledWith('user-pro');
    expect(mocks.tx.liveTutorWallet.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { minutesBalance: { increment: 50 }, topUpSeconds: { increment: 3000 } },
    }));
    expect(mocks.tx.liveTutorMinuteLedger.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ entryType: 'TOP_UP_CREDIT' }),
    }));
  });

  it('does not refill included tutor seconds during payment finalization', async () => {
    configurePayment('SUBSCRIPTION');

    await finalizePayment({
      transactionId: BASE_PAYMENT.id,
      provider: 'GOOGLE_PLAY',
      status: 'SUCCEEDED',
    });

    expect(mocks.tx.liveTutorWallet.findUnique).not.toHaveBeenCalled();
    expect(mocks.tx.liveTutorWallet.update).not.toHaveBeenCalled();
    expect(mocks.tx.liveTutorMinuteLedger.create).not.toHaveBeenCalled();
  });
});
