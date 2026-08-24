import assert from 'node:assert/strict';
import { buildPaymentIdempotencyKey, verifyWebhookSignature } from '../services/paymentService';

async function run() {
  const keyA = buildPaymentIdempotencyKey({
    userId: 'user-1',
    provider: 'PADDLE',
    type: 'SUBSCRIPTION',
    amountUsd: 15,
    currency: 'USD',
    description: 'Pro monthly',
    metadata: { plan: 'PRO' },
  });

  const keyB = buildPaymentIdempotencyKey({
    userId: 'user-1',
    provider: 'PADDLE',
    type: 'SUBSCRIPTION',
    amountUsd: 15,
    currency: 'USD',
    description: 'Pro monthly',
    metadata: { plan: 'PRO' },
  });

  assert.equal(keyA, keyB);

  const signed = await verifyWebhookSignature({
    payload: '{"event":"succeeded"}',
    signature: 'sha256=abc123',
    provider: 'PADDLE',
  });

  assert.equal(signed, false);

  console.log('payment service checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
