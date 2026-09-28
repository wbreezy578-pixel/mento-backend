'use client';

import { useEffect } from 'react';
import { logErrorForDiagnostics } from './lib/errorHandling';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    logErrorForDiagnostics('Global app error', error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'Arial, sans-serif', background: '#0b0f17', color: '#f4f7fb', display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <main style={{ maxWidth: 480, padding: 32, textAlign: 'center' }}>
          <h1 style={{ margin: '0 0 12px', fontSize: 28 }}>Something went wrong</h1>
          <p style={{ margin: '0 0 20px', color: '#d6e0f0', lineHeight: 1.6 }}>
            We hit a problem while loading Mento. Please refresh the page and try again.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            style={{ background: '#facc15', color: '#111827', border: 'none', borderRadius: 999, padding: '12px 20px', fontWeight: 700, cursor: 'pointer' }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
