'use client';

import { useState } from 'react';

export default function UpgradeButton() {
  const [loading, setLoading] = useState(false);

  async function handleUpgrade() {
    if (loading) return;
    setLoading(true);
    try {
      const response = await fetch('/api/payments/checkout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 'pro' }),
      });
      const body = await response.json();
      if (!response.ok || typeof body?.checkoutUrl !== 'string') throw new Error(body?.error || 'Failed to initialize checkout');
      window.location.assign(body.checkoutUrl);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Unable to open checkout.');
      setLoading(false);
    }
  }

  return (
    <button onClick={handleUpgrade} disabled={loading} className="px-4 py-2 bg-yellow-400 rounded">
      {loading ? 'Opening secure checkout…' : 'Upgrade to Pro'}
    </button>
  );
}
