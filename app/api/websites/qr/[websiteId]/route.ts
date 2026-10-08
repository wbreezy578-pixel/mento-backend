import { NextResponse } from 'next/server';
import logger from '../../../../../lib/logger';
import { getPublishedWebsiteQrTarget } from '../../../../../services/websiteQrService';

type RouteContext = { params: Promise<{ websiteId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { websiteId } = await context.params;
    const target = await getPublishedWebsiteQrTarget(websiteId);
    if (!target) {
      return NextResponse.json({ error: 'This published website is unavailable.' }, {
        status: 404,
        headers: { 'Cache-Control': 'no-store, private' },
      });
    }
    return NextResponse.redirect(target.destinationUrl, {
      status: 302,
      headers: { 'Cache-Control': 'no-store, private' },
    });
  } catch (error) {
    logger.error('Published website QR destination could not be resolved', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return NextResponse.json({ error: 'This website link is temporarily unavailable.' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store, private' },
    });
  }
}

export const runtime = 'nodejs';
