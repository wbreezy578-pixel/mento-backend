import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Process liveness endpoint for Azure Container Apps.
 *
 * It deliberately avoids database and provider calls: a failed downstream
 * dependency should not cause Azure to restart an otherwise healthy process.
 */
export function GET() {
  return NextResponse.json({ status: 'ok' });
}
