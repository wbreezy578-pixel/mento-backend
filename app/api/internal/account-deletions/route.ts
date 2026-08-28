import { timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';
import logger from '../../../../lib/logger';
import { retryPendingAccountDeletions } from '../../../../services/accountDeletionService';

export const runtime = 'nodejs';

function tokenMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(`Bearer ${expected}`);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function POST(req: Request) {
  const secret = process.env.RETENTION_JOB_SECRET?.trim();
  if (!secret) return NextResponse.json({ error: 'Deletion retry job is not configured' }, { status: 503 });
  if (!tokenMatches(req.headers.get('authorization'), secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    const result = await retryPendingAccountDeletions();
    return NextResponse.json({ success: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    logger.error('Account deletion retry job failed', { error });
    return NextResponse.json({ error: 'Deletion retry job failed' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
