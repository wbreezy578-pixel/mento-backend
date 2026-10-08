import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Process liveness endpoint for the service runtime.
 *
 * It deliberately avoids database and provider calls: a failed downstream
 * dependency should not restart an otherwise healthy process.
 */
export function GET() {
  return NextResponse.json({ status: 'ok' });
}
