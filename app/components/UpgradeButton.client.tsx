"use client";
import React, { useState } from 'react';

declare global {
  interface Window {
    Paddle?: any;
  }
}

async function loadPaddleScript(): Promise<void> {
  if (typeof window === 'undefined') return;
  if ((window as any).Paddle) return;

  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-paddle]');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Paddle script failed to load')));
      return;
    }

    const s = document.createElement('script');
    s.setAttribute('data-paddle', 'true');
    s.src = 'https://cdn.paddle.com/paddle/paddle.js';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Paddle script failed to load'));
    document.head.appendChild(s);
  });
}

export default function UpgradeButton() {
  const [loading, setLoading] = useState(false);

  async function handleUpgrade() {
    if (loading) return;
    setLoading(true);
    try {
      const resp = await fetch('/api/payments/checkout', { method: 'POST', credentials: 'same-origin' });
      if (resp.status === 401) {
        alert('Please sign in to upgrade');
        setLoading(false);
        return;
      }
      const body = await resp.json();
      if (!resp.ok || body?.error) {
        alert(body?.error || 'Failed to initialize checkout');
        setLoading(false);
        return;
      }

      const { priceId, environment, clientToken, passthrough } = body as { priceId: string; environment: string; clientToken?: string | null; passthrough: string };

      if (!priceId) {
        alert('Server did not return a price id');
        setLoading(false);
        return;
      }

      try {
        await loadPaddleScript();
      } catch (err) {
        alert('Failed to load Paddle checkout script');
        setLoading(false);
        return;
      }

      if (!window.Paddle) {
        alert('Paddle SDK unavailable');
        setLoading(false);
        return;
      }

      try {
        // Initialize Paddle client with client-safe token if provided. Use sandbox when requested.
        if (clientToken) {
          try { window.Paddle.Setup({ token: clientToken }); } catch (e) { /* ignore setup errors */ }
        }
        if (environment === 'sandbox') {
          try { window.Paddle.Environment && window.Paddle.Environment('sandbox'); } catch (e) { /* best-effort */ }
        }

        // Open checkout. Use server-provided priceId and passthrough which includes mentoUserId and transactionId.
        // Do NOT trust client-supplied values: the server returns authoritative priceId and passthrough.
        window.Paddle.Checkout.open({
          product: priceId,
          passthrough,
        });

        // Show transient state to user — payment processing is pending until webhook reconciliation.
        alert('Checkout opened. Payment processing is pending until confirmation.');
      } catch (err) {
        console.error('Paddle checkout error', err);
        alert('Failed to initialize Paddle checkout');
      }
    } catch (err) {
      console.error(err);
      alert('Network error initializing checkout');
    } finally {
      setLoading(false);
    }
  }

  return (
    <button onClick={handleUpgrade} disabled={loading} className="px-4 py-2 bg-yellow-400 rounded">
      {loading ? 'Opening checkout...' : 'Upgrade to Pro'}
    </button>
  );
}
