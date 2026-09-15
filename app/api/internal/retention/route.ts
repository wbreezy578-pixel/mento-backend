import { NextResponse } from 'next/server';
import logger from '../../../../lib/logger';
import { verifyInternalJobRequest } from '../../../../lib/internalJobAuth';
import { purgeExpiredConversations } from '../../../../services/dataRetentionService';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const secret = process.env.RETENTION_JOB_SECRET?.trim();
  if (!secret) return NextResponse.json({ error: 'Retention job is not configured' }, { status: 503 });
  const authentication = await verifyInternalJobRequest(req, secret);
  if (!authentication.ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: authentication.reason === 'replayed' ? 409 : 401, headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    const result = await purgeExpiredConversations();
    logger.info('Conversation retention job completed', { deletedConversations: result.deletedConversations, cutoff: result.cutoff.toISOString() });
    return NextResponse.json({ success: true, deletedConversations: result.deletedConversations, cutoff: result.cutoff.toISOString() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    logger.error('Conversation retention job failed', { error: error instanceof Error ? error.message : 'unknown' });
    return NextResponse.json({ error: 'Retention job failed' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
