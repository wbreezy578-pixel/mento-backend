import type { Metadata } from 'next';
import AuthActionClient from '../AuthActionClient';

export const metadata: Metadata = { title: 'Confirm email change — Mento', robots: { index: false, follow: false, noarchive: true } };

export default async function ConfirmEmailChangePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const rawToken = (await searchParams).token;
  const token = typeof rawToken === 'string' ? rawToken : '';
  return <AuthActionClient action="confirm-email-change" token={token} mobileScheme={process.env.MOBILE_APP_SCHEME?.trim() || 'mentomobile'} />;
}
