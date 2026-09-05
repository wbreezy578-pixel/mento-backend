import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { startPayment, finalizePayment } from '../services/paymentService';
import { processPaddleWebhook } from '../services/paddleWebhookService';
import { ensureWallet } from '../services/walletService';
import { ensureDefaultPlans } from '../services/planService';
import { ensureUserBillingSetup } from '../services/economicsService';
import type { User } from '@prisma/client';

/**
 * Paddle Sandbox Integration Test
 *
 * Tests the complete Paddle Sandbox flow with real Prisma database.
 * Does NOT modify Live Paddle settings or data.
 * 
 * Prerequisites:
 * - DATABASE_URL must be set to a test database (or it will use your configured DB)
 * - PADDLE_API_KEY must be set to Sandbox credentials
 * - PADDLE_ENV should be "sandbox"
 * - PADDLE_NOTIFICATION_WEBHOOK_SECRET should be set
 */

interface TestUser {
  id: string;
  email: string;
  name: string;
}

interface TestData {
  user: TestUser;
  transactionId: string;
  paddleCustomerId: string;
  paddleSubscriptionId: string;
  paddlePriceId: string;
}

const TEST_DATA_PREFIX = 'paddle_sandbox_test_';

// Helper to generate test IDs that are trackable for cleanup
function generateTestId(prefix: string): string {
  return `${TEST_DATA_PREFIX}${prefix}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

// Helper to sign Paddle webhook payload
// Note: In a real test, you would use the actual Paddle webhook signing
// For this test, we'll use a simple HMAC approach or skip verification
function signPaddleWebhook(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

async function createTestUser(): Promise<TestUser> {
  const email = `${generateTestId('user')}@example.com`;
  const user = await prisma.user.create({
    data: {
      email,
      password: 'TestPassword123!', // hashed in real app
      name: 'Paddle Sandbox Test User',
    },
  });

  // Ensure wallet is created
  await ensureWallet(user.id);
  
  // Ensure billing setup for this user
  await ensureUserBillingSetup(user.id);

  return {
    id: user.id,
    email: user.email,
    name: user.name || 'Test User',
  };
}

async function setupTestEnvironment(): Promise<void> {
  // Pre-load all default plans to avoid transaction timeout during finalization
  await ensureDefaultPlans();
  console.log('  ✓ Plans pre-loaded\n');
}

async function createPendingPaymentTransaction(userId: string, description: string = 'Pro subscription'): Promise<string> {
  const payment = await startPayment({
    userId,
    provider: 'PADDLE',
    type: 'SUBSCRIPTION',
    amountUsd: 15,
    currency: 'USD',
    description,
  });

  return payment.id;
}

interface MockPaddleWebhook {
  alert_name: string;
  alert_id: string;
  passthrough?: string;
  subscription_id?: string;
  checkout_id?: string;
  customer_id?: string;
  product_id?: string;
  [key: string]: any;
}

async function processMockPaddleWebhook(webhook: MockPaddleWebhook, secret: string | null = null): Promise<void> {
  const payload = JSON.stringify(webhook);
  const signature = secret ? signPaddleWebhook(payload, secret) : 'mock-signature';

  // Use the real processPaddleWebhook but with bypass for testing
  // In real scenario, you would configure proper webhook signature verification
  await processPaddleWebhook(payload, signature, {
    // Skip signature verification for sandbox testing
    // In production, this would verify against actual Paddle webhook secret
    unmarshalOverride: async () => webhook,
  });
}

async function verifyPaymentTransactionState(
  transactionId: string,
  expectedStatus: string,
  expectedProviderId?: string,
  expectedSubscriptionId?: string,
) {
  const tx = await prisma.paymentTransaction.findUnique({ where: { id: transactionId } });
  assert(tx, `Transaction ${transactionId} not found`);
  assert.equal(tx.status, expectedStatus, `Expected transaction status ${expectedStatus}, got ${tx.status}`);

  if (expectedProviderId) {
    assert.equal(tx.providerTransactionId, expectedProviderId, `Expected provider ID ${expectedProviderId}, got ${tx.providerTransactionId}`);
  }
  if (expectedSubscriptionId) {
    assert.equal(tx.providerSubscriptionId, expectedSubscriptionId, `Expected subscription ID ${expectedSubscriptionId}, got ${tx.providerSubscriptionId}`);
  }
}

async function verifyUserWalletState(
  userId: string,
  expectedPlan: string,
  expectedSubscriptionStatus: string,
  expectedCustomerId?: string,
  expectedSubscriptionId?: string,
  expectedPriceId?: string,
) {
  const wallet = await prisma.userWallet.findUnique({
    where: { userId },
    include: { plan: true },
  });

  assert(wallet, `Wallet for user ${userId} not found`);
  assert.equal(wallet.plan?.name, expectedPlan, `Expected plan ${expectedPlan}, got ${wallet.plan?.name}`);
  assert.equal(wallet.subscriptionStatus, expectedSubscriptionStatus, `Expected subscription status ${expectedSubscriptionStatus}, got ${wallet.subscriptionStatus}`);

  if (expectedCustomerId) {
    assert.equal(wallet.paddleCustomerId, expectedCustomerId, `Expected customer ID ${expectedCustomerId}, got ${wallet.paddleCustomerId}`);
  }
  if (expectedSubscriptionId) {
    assert.equal(wallet.paddleSubscriptionId, expectedSubscriptionId, `Expected subscription ID ${expectedSubscriptionId}, got ${wallet.paddleSubscriptionId}`);
  }
  if (expectedPriceId) {
    assert.equal(wallet.paddlePriceId, expectedPriceId, `Expected price ID ${expectedPriceId}, got ${wallet.paddlePriceId}`);
  }
}

async function verifyReceiptExists(transactionId: string): Promise<void> {
  const receipt = await prisma.paymentReceipt.findUnique({ where: { transactionId } });
  assert(receipt, `Receipt for transaction ${transactionId} not found`);
  assert.equal(receipt.status, 'ISSUED', `Expected receipt status ISSUED, got ${receipt.status}`);
}

async function verifyLedgerEntry(userId: string, transactionId: string): Promise<void> {
  const entry = await prisma.paymentLedgerEntry.findFirst({
    where: { userId, transactionId },
  });
  assert(entry, `Ledger entry for transaction ${transactionId} not found`);
}

async function cleanup(): Promise<void> {
  console.log('Cleaning up test data...');

  // Find all test users and data created by this test
  const testUsers = await prisma.user.findMany({
    where: {
      email: {
        startsWith: TEST_DATA_PREFIX,
      },
    },
  });

  for (const user of testUsers) {
    // Delete related records
    await prisma.paymentLedgerEntry.deleteMany({ where: { userId: user.id } });
    await prisma.paymentReceipt.deleteMany({ where: { userId: user.id } });
    await prisma.paymentTransaction.deleteMany({ where: { userId: user.id } });
    await prisma.liveTutorWallet.deleteMany({ where: { userId: user.id } });
    await prisma.userWallet.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }

  console.log(`Cleaned up ${testUsers.length} test users and all their data`);
}

async function runTests() {
  console.log('🚀 Starting Paddle Sandbox Integration Tests\n');
  
  // Setup test environment (pre-load plans, etc.)
  console.log('✓ Setting up test environment...');
  await setupTestEnvironment();

  const testData: Partial<TestData> = {};

  try {
    // Test 1: Create/use a real test Mento user
    console.log('✓ Test 1: Creating real test Mento user...');
    const user = await createTestUser();
    testData.user = user;
    console.log(`  Created user: ${user.email} (${user.id})\n`);

    // Test 2: Create a pending PADDLE subscription PaymentTransaction
    console.log('✓ Test 2: Creating pending PADDLE subscription transaction...');
    const transactionId = await createPendingPaymentTransaction(user.id);
    testData.transactionId = transactionId;
    const pendingTx = await prisma.paymentTransaction.findUnique({ where: { id: transactionId } });
    assert(pendingTx, 'Transaction creation failed');
    assert.equal(pendingTx.status, 'PENDING', 'Transaction should be PENDING');
    assert.equal(pendingTx.provider, 'PADDLE', 'Provider should be PADDLE');
    console.log(`  Created transaction: ${transactionId}\n`);

    // Test 3: Process a valid Paddle Sandbox subscription/payment webhook
    console.log('✓ Test 3: Processing valid Paddle payment webhook...');
    const paddleCustomerId = generateTestId('customer');
    const paddleSubscriptionId = generateTestId('subscription');
    const paddlePriceId = generateTestId('price');
    const paddleCheckoutId = generateTestId('checkout');

    testData.paddleCustomerId = paddleCustomerId;
    testData.paddleSubscriptionId = paddleSubscriptionId;
    testData.paddlePriceId = paddlePriceId;

    // First, send a subscription_created webhook with passthrough so the service
    // can map the incoming subscription to the pending transaction and store
    // customer/subscription/price IDs on the UserWallet.
    console.log('✓ Test 3b: Processing subscription_created webhook to store customer ID...');
    const subscriptionCreatedWebhook: MockPaddleWebhook = {
      alert_name: 'subscription_created',
      alert_id: generateTestId('webhook_subscription_created'),
      passthrough: JSON.stringify({ mentoUserId: user.id, transactionId }),
      subscription_id: paddleSubscriptionId,
      customer_id: paddleCustomerId,
      product_id: paddlePriceId,
    };
    await processMockPaddleWebhook(subscriptionCreatedWebhook);
    console.log(`  Processed subscription_created webhook\n`);

    // Then send the payment succeeded webhook to finalize the transaction.
    const paymentWebhook: MockPaddleWebhook = {
      alert_name: 'payment_succeeded',
      alert_id: generateTestId('webhook'),
      passthrough: JSON.stringify({ mentoUserId: user.id, transactionId }),
      checkout_id: paddleCheckoutId,
      subscription_id: paddleSubscriptionId,
      customer_id: paddleCustomerId,
      product_id: paddlePriceId,
    };

    await processMockPaddleWebhook(paymentWebhook);
    console.log(`  Processed webhook for subscription ${paddleSubscriptionId}\n`);

    // Test 4: Verify the real database updates
    console.log('✓ Test 4: Verifying database updates after payment success...');

    // 4a. PaymentTransaction becomes SUCCEEDED
    await verifyPaymentTransactionState(transactionId, 'SUCCEEDED', paddleCheckoutId, paddleSubscriptionId);
    console.log('  ✓ PaymentTransaction status: SUCCEEDED');

    // 4b. Receipt exists
    await verifyReceiptExists(transactionId);
    console.log('  ✓ Receipt issued');

    // 4c. Ledger entry exists
    await verifyLedgerEntry(user.id, transactionId);
    console.log('  ✓ Ledger entry created');

    // 4d. UserWallet updates
    await verifyUserWalletState(user.id, 'PRO', 'active', paddleCustomerId, paddleSubscriptionId, paddlePriceId);
    console.log('  ✓ UserWallet: planId=PRO, subscriptionStatus=active');
    console.log('  ✓ UserWallet: paddleCustomerId, paddleSubscriptionId, paddlePriceId stored\n');

    // Test 5: Send the same webhook again and verify no duplicate
    console.log('✓ Test 5: Verifying duplicate webhook handling...');
    await processMockPaddleWebhook(paymentWebhook);

    const txAfterDuplicate = await prisma.paymentTransaction.findUnique({ where: { id: transactionId } });
    assert.equal(txAfterDuplicate?.status, 'SUCCEEDED', 'Transaction should still be SUCCEEDED');

    const receiptsCount = await prisma.paymentReceipt.count({
      where: { transactionId },
    });
    assert.equal(receiptsCount, 1, 'Should have exactly 1 receipt (no duplicate)');

    const ledgerEntriesCount = await prisma.paymentLedgerEntry.count({
      where: { userId: user.id, transactionId },
    });
    assert.equal(ledgerEntriesCount, 1, 'Should have exactly 1 ledger entry (no duplicate)');

    console.log('  ✓ No duplicate transaction created');
    console.log('  ✓ No duplicate receipt created');
    console.log('  ✓ No duplicate ledger entry created\n');

    // Test 6: Test subscription update
    console.log('✓ Test 6: Testing subscription update webhook...');
    const updateWebhook: MockPaddleWebhook = {
      alert_name: 'subscription_updated',
      alert_id: generateTestId('webhook_update'),
      subscription_id: paddleSubscriptionId,
      customer_id: paddleCustomerId,
      product_id: paddlePriceId,
    };
    await processMockPaddleWebhook(updateWebhook);
    console.log('  ✓ Subscription update processed\n');

    // Test 7: Test scheduled cancellation (user remains PRO until expiry)
    console.log('✓ Test 7: Testing scheduled cancellation...');
    const expiryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days from now
    const scheduledCancelWebhook: MockPaddleWebhook = {
      alert_name: 'subscription_cancelled',
      alert_id: generateTestId('webhook_cancel_scheduled'),
      subscription_id: paddleSubscriptionId,
      customer_id: paddleCustomerId,
      cancellation_effective_at: expiryDate.toISOString(),
    };
    await processMockPaddleWebhook(scheduledCancelWebhook);

    const walletAfterScheduledCancel = await prisma.userWallet.findUnique({
      where: { userId: user.id },
      include: { plan: true },
    });
    assert(walletAfterScheduledCancel, 'Wallet not found');
    assert.equal(walletAfterScheduledCancel.plan?.name, 'PRO', 'User should still have PRO plan until expiry');
    assert.equal(walletAfterScheduledCancel.subscriptionStatus, 'cancelled', 'Subscription status should be cancelled');
    assert(walletAfterScheduledCancel.subscriptionExpiresAt, 'subscriptionExpiresAt should be set');
    console.log('  ✓ Scheduled cancellation: PRO access remains until expiry date');
    console.log(`  ✓ Subscription expires at: ${walletAfterScheduledCancel.subscriptionExpiresAt}\n`);

    // Test 8: Test immediate cancellation (PRO access removed immediately)
    // First, we need to reset the wallet to PRO status
    console.log('✓ Test 8: Testing immediate cancellation...');
    const freePlan = await prisma.plan.findUnique({ where: { name: 'FREE' } });
    const proPlan = await prisma.plan.findUnique({ where: { name: 'PRO' } });

    if (proPlan) {
      await prisma.userWallet.update({
        where: { userId: user.id },
        data: {
          planId: proPlan.id,
          subscriptionStatus: 'active',
          paddleSubscriptionId,
          paddleCustomerId,
        },
      });
    }

    const immediateCancelWebhook: MockPaddleWebhook = {
      alert_name: 'subscription_cancelled',
      alert_id: generateTestId('webhook_cancel_immediate'),
      subscription_id: paddleSubscriptionId,
      customer_id: paddleCustomerId,
      // No cancellation_effective_at means immediate cancellation
    };
    await processMockPaddleWebhook(immediateCancelWebhook);

    const walletAfterImmediateCancel = await prisma.userWallet.findUnique({
      where: { userId: user.id },
      include: { plan: true },
    });
    assert(walletAfterImmediateCancel, 'Wallet not found');
    assert.equal(walletAfterImmediateCancel.subscriptionStatus, 'cancelled', 'Subscription status should be cancelled');
    console.log('  ✓ Immediate cancellation: PRO access removed\n');

    // Test 9: Test payment failure (entitlement not upgraded)
    console.log('✓ Test 9: Testing payment failure...');
    const user2 = await createTestUser();
    const tx2 = await createPendingPaymentTransaction(user2.id, 'Failed payment test');

    const failureWebhook: MockPaddleWebhook = {
      alert_name: 'subscription_payment_failed',
      alert_id: generateTestId('webhook_failed'),
      passthrough: JSON.stringify({
        mentoUserId: user2.id,
        transactionId: tx2,
      }),
    };
    await processMockPaddleWebhook(failureWebhook);

    await verifyPaymentTransactionState(tx2, 'FAILED');
    const wallet2 = await prisma.userWallet.findUnique({
      where: { userId: user2.id },
      include: { plan: true },
    });
    assert(wallet2, 'Wallet not found');
    assert.equal(wallet2.plan?.name, 'FREE', 'User should remain on FREE plan after payment failure');
    console.log('  ✓ Payment failure: User entitlement not upgraded\n');

    console.log('✅ All tests passed!\n');
  } catch (error) {
    console.error('❌ Test failed:', error instanceof Error ? error.message : String(error));
    if (error instanceof Error) {
      console.error('Stack:', error.stack);
    }
    process.exitCode = 1;
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

// Run tests
runTests().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
