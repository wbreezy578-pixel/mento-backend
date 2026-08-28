import { NextResponse } from 'next/server';
import logger from '../../../../lib/logger';
import { verifyInternalJobRequest } from '../../../../lib/internalJobAuth';
import { retryPendingAccountDeletions } from '../../../../services/accountDeletionService';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const secret = process.env.RETENTION_JOB_SECRET?.trim();
  if (!secret) return NextResponse.json({ error: 'Deletion retry job is not configured' }, { status: 503 });
  const authentication = await verifyInternalJobRequest(req, secret);
  if (!authentication.ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: authentication.reason === 'replayed' ? 409 : 401, headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    const result = await retryPendingAccountDeletions();
    return NextResponse.json({ success: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    logger.error('Account deletion retry job failed', { error: error instanceof Error ? error.message : 'unknown' });
    return NextResponse.json({ error: 'Deletion retry job failed' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
