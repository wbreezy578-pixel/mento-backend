'use client';

import Script from 'next/script';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

type PaddleCheckoutEvent = { name?: string; data?: { transaction_id?: string; id?: string } };
type PaddleBrowserSdk = {
  Environment: { set(environment: 'sandbox'): void };
  Initialize(options: { token: string; eventCallback(event: PaddleCheckoutEvent): void }): void;
  Checkout: { open(options: Record<string, unknown>): void };
};

declare global {
  interface Window { Paddle?: PaddleBrowserSdk }
}

export default function BillingCheckout({ clientToken, environment }: { clientToken: string; environment: 'sandbox' | 'production' }) {
  const initialized = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function initialize() {
    if (initialized.current || !window.Paddle) return;
    initialized.current = true;
    try {
      if (environment === 'sandbox') window.Paddle.Environment.set('sandbox');
      window.Paddle.Initialize({
        token: clientToken,
        eventCallback: (event: PaddleCheckoutEvent) => {
          if (event?.name === 'checkout.completed') {
            const id = event?.data?.transaction_id ?? event?.data?.id ?? '';
            router.push(`/billing/success?paddleTransactionId=${encodeURIComponent(id)}`);
          }
        },
      });
      const paddleTransactionId = new URLSearchParams(window.location.search).get('_ptxn');
      if (!paddleTransactionId?.startsWith('txn_')) throw new Error('This checkout link is invalid or incomplete.');
      window.Paddle.Checkout.open({
        transactionId: paddleTransactionId,
        settings: {
          displayMode: 'overlay',
          successUrl: `${window.location.origin}/billing/success?paddleTransactionId=${encodeURIComponent(paddleTransactionId)}`,
        },
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to open Paddle checkout.');
    }
  }

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#f7f7fb', color: '#17171f' }}>
      <Script src="https://cdn.paddle.com/paddle/v2/paddle.js" strategy="afterInteractive" onLoad={initialize} onReady={initialize} onError={() => setError('Paddle checkout could not be loaded.')} />
      <section style={{ maxWidth: 520, padding: 32, borderRadius: 20, background: 'white', boxShadow: '0 20px 60px rgba(0,0,0,.08)', textAlign: 'center' }}>
        <h1 style={{ marginBottom: 12 }}>Mento secure checkout</h1>
        <p>{error ?? 'Preparing your payment…'}</p>
        {error ? <button onClick={() => { initialized.current = false; setError(null); initialize(); }} style={{ marginTop: 20, padding: '12px 18px' }}>Try again</button> : null}
      </section>
    </main>
  );
}
