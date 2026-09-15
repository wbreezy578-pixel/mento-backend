import assert from 'node:assert/strict';
import { createProCheckoutForUser } from '../services/paddleService';

async function run() {
  process.env.PADDLE_PRO_PRICE_ID = 'pri_test_pro_123';
  process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN = 'test_client_token';
  process.env.PADDLE_ENV = 'sandbox';

  const userId = 'test-user-42';

  const result = await createProCheckoutForUser(userId, { createTransaction: false });

  // Server must use authoritative price id
  assert.equal(result.priceId, 'pri_test_pro_123');

  // Client token should be present (safe public token)
  assert.equal(result.clientToken, 'test_client_token');

  // Environment must be sandbox for our test
  assert.equal(result.environment, 'sandbox');

  // Passthrough must contain the mento user id
  const passthrough = JSON.parse(result.passthrough);
  assert.equal(passthrough.mentoUserId, userId);

  // No server secret should be present in the returned object
  const exportedKeys = Object.keys(result);
  assert(!exportedKeys.includes('PADDLE_API_KEY'));

  console.log('paddle checkout test passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
