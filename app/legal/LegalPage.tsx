import type { ReactNode } from 'react';

export default function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <main style={{ maxWidth: 820, margin: '0 auto', padding: '48px 24px 80px', color: '#172033', fontFamily: 'system-ui, sans-serif', lineHeight: 1.65 }}>
      <a href="/" style={{ color: '#2856d6' }}>Mento</a>
      <h1 style={{ fontSize: 36, marginBottom: 4 }}>{title}</h1>
      <p style={{ color: '#5d6678', marginTop: 0 }}>Last updated: {updated}</p>
      <div>{children}</div>
    </main>
  );
}
