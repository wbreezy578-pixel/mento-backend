import { getPaddleClientToken, getPaddleEnv } from '../../../lib/env';
import BillingCheckout from './BillingCheckout.client';

export const dynamic = 'force-dynamic';

export default function BillingCheckoutPage() {
  const clientToken = getPaddleClientToken();
  if (!clientToken) {
    return <main style={{ padding: 32 }}>Billing checkout is not configured.</main>;
  }
  return <BillingCheckout clientToken={clientToken} environment={getPaddleEnv()} />;
}
