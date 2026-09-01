import { getPaddleClientToken, getPaddleEnv } from '../../../lib/env';
import { headers } from 'next/headers';
import BillingCheckout from './BillingCheckout.client';

export const dynamic = 'force-dynamic';

export default async function BillingCheckoutPage() {
  const nonce = (await headers()).get('x-nonce');
  if (process.env.NODE_ENV === 'production' && !nonce) {
    throw new Error('Checkout security context is unavailable.');
  }
  const clientToken = getPaddleClientToken();
  if (!clientToken) {
    return <main style={{ padding: 32 }}>Billing checkout is not configured.</main>;
  }
  return <BillingCheckout clientToken={clientToken} environment={getPaddleEnv()} nonce={nonce ?? undefined} />;
}
