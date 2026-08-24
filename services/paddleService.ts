import { getPaddleProPriceId, getPaddleClientToken, getPaddleEnv } from '../lib/env';
import { startPayment } from './paymentService';

export interface ProCheckoutInitialization {
  priceId: string;
  environment: string; // 'sandbox' | 'production'
  clientToken: string | null;
  transactionId: string | null; // pending transaction created server-side (may be null if creation skipped)
  passthrough: string; // JSON string the client should pass to Paddle (includes mento user id and transaction id)
}

export async function createProCheckoutForUser(userId: string, options?: { createTransaction?: boolean }): Promise<ProCheckoutInitialization> {
  const priceId = getPaddleProPriceId();
  const clientToken = getPaddleClientToken();
  const environment = getPaddleEnv();

  const createTransaction = options?.createTransaction !== false;

  let transactionId: string | null = null;
  if (createTransaction) {
    const tx = await startPayment({
      userId,
      provider: 'PADDLE',
      type: 'SUBSCRIPTION',
      amountUsd: 0, // amount is authoritative from Paddle price; store 0 here to record intent
      currency: 'USD',
      description: 'Paddle Pro checkout initiated',
      metadata: { plan: 'PRO' },
    });
    transactionId = tx.id;
  }

  const passthrough = JSON.stringify({ mentoUserId: userId, transactionId });

  return {
    priceId,
    environment,
    clientToken,
    transactionId,
    passthrough,
  };
}

export default { createProCheckoutForUser };
