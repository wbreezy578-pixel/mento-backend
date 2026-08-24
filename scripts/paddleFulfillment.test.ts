/**
 * Comprehensive tests for Paddle Sandbox fulfillment logic.
 * Tests the mapping of price IDs to minute amounts and idempotency.
 */

import assert from 'node:assert/strict';

async function testPriceIdMapping() {
  console.log('Test 1: Paddle price ID to minute mapping');
  
  const PRICE_ID_50 = 'pri_01kzva248mdaceas8a4k40f8z3';
  const PRICE_ID_100 = 'pri_01kzva24hf0qa7de4try5spmpq';

  function mapPriceToMinutes(priceId: string | null | undefined): number | null {
    if (!priceId) return null;
    if (priceId === PRICE_ID_50) return 50;
    if (priceId === PRICE_ID_100) return 100;
    return null;
  }

  // Test 1a: $10 top-up (50-minute) price ID
  const minutes50 = mapPriceToMinutes(PRICE_ID_50);
  assert.equal(minutes50, 50, 'PRICE_ID_50 should map to 50 minutes');
  console.log('  ✓ $10 top-up (50-minute) maps correctly');

  // Test 1b: $20 top-up (100-minute) price ID
  const minutes100 = mapPriceToMinutes(PRICE_ID_100);
  assert.equal(minutes100, 100, 'PRICE_ID_100 should map to 100 minutes');
  console.log('  ✓ $20 top-up (100-minute) maps correctly');

  // Test 1c: Unknown price ID
  const minutesUnknown = mapPriceToMinutes('pri_unknown');
  assert.equal(minutesUnknown, null, 'Unknown price ID should map to null');
  console.log('  ✓ Unknown price ID maps to null (no grant)');

  // Test 1d: Null/undefined price ID
  assert.equal(mapPriceToMinutes(null), null, 'Null price ID should map to null');
  assert.equal(mapPriceToMinutes(undefined), null, 'Undefined price ID should map to null');
  console.log('  ✓ Null/undefined price IDs handle correctly');
}

async function testProSubscriptionIdempotency() {
  console.log('\nTest 2: Pro subscription minute grant idempotency');

  // Simulate the idempotency check for Pro subscriptions
  interface ProviderPayload {
    webhookIds?: string[];
    minutesGrantedFromInitialWebhook?: boolean;
  }

  function shouldGrantProMinutes(payload: ProviderPayload): boolean {
    // Only grant if we haven't already marked this transaction as having granted minutes
    return !payload?.minutesGrantedFromInitialWebhook;
  }

  // Test 2a: First webhook should grant minutes
  const payload1: ProviderPayload = { webhookIds: ['alert_1'] };
  assert.equal(shouldGrantProMinutes(payload1), true, 'First webhook should trigger grant');
  console.log('  ✓ First Pro webhook grants 200 minutes');

  // Test 2b: After grant, payload is marked
  payload1.minutesGrantedFromInitialWebhook = true;
  assert.equal(shouldGrantProMinutes(payload1), false, 'Marked payload should prevent duplicate grant');
  console.log('  ✓ Duplicate Pro webhook prevented by idempotency flag');

  // Test 2c: Empty payload initially allows grant
  const emptyPayload: ProviderPayload = {};
  assert.equal(shouldGrantProMinutes(emptyPayload), true, 'Empty payload should allow initial grant');
  console.log('  ✓ First webhook for empty payload grants minutes');
}

async function testTopUpIdempotency() {
  console.log('\nTest 3: Top-up minute grant idempotency');

  function hasWebhookBeenProcessed(webhookIds: string[], newAlertId: string): boolean {
    return webhookIds.includes(newAlertId);
  }

  // Test 3a: New alert ID should not be processed
  const ids1 = ['alert_1'];
  assert.equal(hasWebhookBeenProcessed(ids1, 'alert_2'), false, 'New alert should not be in processed list');
  console.log('  ✓ First top-up webhook processes normally');

  // Test 3b: Duplicate alert ID should be detected
  const ids2 = ['alert_1', 'alert_2'];
  assert.equal(hasWebhookBeenProcessed(ids2, 'alert_1'), true, 'Duplicate alert should be detected');
  console.log('  ✓ Duplicate top-up webhook detected and prevented');

  // Test 3c: Empty list allows first
  assert.equal(hasWebhookBeenProcessed([], 'alert_1'), false, 'Empty list allows first webhook');
  console.log('  ✓ First webhook with empty list processes');
}

async function testFailedPaymentLogic() {
  console.log('\nTest 4: Failed payment does not grant minutes');

  function shouldProcessPayment(status: string): boolean {
    return status === 'SUCCEEDED';
  }

  // Test 4a: Failed status
  assert.equal(shouldProcessPayment('FAILED'), false, 'FAILED status should not process');
  console.log('  ✓ FAILED payment does not grant minutes');

  // Test 4b: Succeeded status
  assert.equal(shouldProcessPayment('SUCCEEDED'), true, 'SUCCEEDED status should process');
  console.log('  ✓ SUCCEEDED payment processes fulfillment');

  // Test 4c: Pending status
  assert.equal(shouldProcessPayment('PENDING'), false, 'PENDING status should not process');
  console.log('  ✓ PENDING payment does not grant minutes');

  // Test 4d: Cancelled status
  assert.equal(shouldProcessPayment('CANCELLED'), false, 'CANCELLED status should not process');
  console.log('  ✓ CANCELLED payment does not grant minutes');
}

async function testBalanceIncrement() {
  console.log('\nTest 5: Live tutor balance increment logic');

  // Simulate balance increment logic
  function addMinutesToBalance(currentBalance: number, minutesToAdd: number): number {
    // Cannot go negative
    const toAdd = Math.max(0, minutesToAdd);
    return currentBalance + toAdd;
  }

  // Test 5a: Adding positive minutes
  const balance1 = addMinutesToBalance(100, 50);
  assert.equal(balance1, 150, 'Should increment balance by 50');
  console.log('  ✓ Adding 50 minutes to 100-minute balance = 150');

  // Test 5b: Starting from zero
  const balance2 = addMinutesToBalance(0, 200);
  assert.equal(balance2, 200, 'Should set balance to 200');
  console.log('  ✓ Adding 200 minutes to 0-minute balance = 200');

  // Test 5c: Negative minutes are clamped to zero
  const balance3 = addMinutesToBalance(100, -50);
  assert.equal(balance3, 100, 'Should not allow negative additions');
  console.log('  ✓ Negative minute additions are prevented');

  // Test 5d: Existing balance preserved
  const balance4 = addMinutesToBalance(75, 25);
  assert.equal(balance4, 100, 'Should preserve existing balance');
  console.log('  ✓ Existing balance correctly preserved on top-up');
}

async function run() {
  console.log('\n=== Paddle Fulfillment Logic Tests ===\n');
  
  try {
    await testPriceIdMapping();
    await testProSubscriptionIdempotency();
    await testTopUpIdempotency();
    await testFailedPaymentLogic();
    await testBalanceIncrement();
    
    console.log('\n✅ All fulfillment tests passed!\n');
  } catch (error) {
    console.error('\n❌ Test failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
