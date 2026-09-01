import type { Metadata } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Mento',
  description: 'Mento is an AI learning companion for focused chat, image understanding, and optional Live Tutor conversations.',
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // Nonce-based CSP requires request-time rendering so Next.js can apply the
  // request's nonce to framework and page scripts.
  await connection();
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
