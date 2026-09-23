import { NextResponse } from 'next/server';
import { metricsText } from '../../../lib/metrics';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const configuredToken = process.env.METRICS_AUTH_TOKEN?.trim();
  if (process.env.NODE_ENV === 'production' && !configuredToken) {
    return NextResponse.json({ error: 'Metrics are not configured' }, { status: 503 });
  }
  if (configuredToken && req.headers.get('authorization') !== `Bearer ${configuredToken}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    const body = await metricsText();
    return new NextResponse(body, { status: 200, headers: { 'Content-Type': 'text/plain; version=0.0.4', 'Cache-Control': 'no-store' } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to gather metrics';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
