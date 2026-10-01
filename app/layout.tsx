import type { Metadata } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.AUTH_WEB_BASE_URL || 'https://auth.trymentoapp.com'),
  title: 'Mento',
  description: 'Mento is an AI learning companion for focused chat, image understanding, and optional Live Tutor conversations.',
  openGraph: {
    type: 'website',
    siteName: 'Mento',
    title: 'Mento',
    description: 'An AI learning companion for focused chat, image understanding, and optional Live Tutor conversations.',
  },
  twitter: {
    card: 'summary',
    title: 'Mento',
    description: 'An AI learning companion for focused chat, image understanding, and optional Live Tutor conversations.',
  },
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
