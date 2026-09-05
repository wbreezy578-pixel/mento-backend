import type { Metadata } from 'next';
import AuthActionClient from '../AuthActionClient';

export const metadata: Metadata = { title: 'Verify email — Mento', robots: { index: false, follow: false, noarchive: true } };

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const rawToken = (await searchParams).token;
  const token = typeof rawToken === 'string' ? rawToken : '';
  return <AuthActionClient action="verify-email" token={token} mobileScheme={process.env.MOBILE_APP_SCHEME?.trim() || 'mentomobile'} />;
}
