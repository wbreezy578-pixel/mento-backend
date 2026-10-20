import { NextResponse } from 'next/server';
import { prisma } from '../../../lib/prisma';
import { AIRequestGatewayError, authenticateAIRequest } from '../../../lib/aiSecurityGateway';
import { buildCorsHeaders } from '../../../lib/securityHeaders';
import { listJsonResponse } from '../../../lib/apiListTelemetry';

function headers(req: Request) {
  return { ...buildCorsHeaders(req.headers.get('origin')), 'Cache-Control': 'no-store, private' };
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
}

export async function GET(req: Request) {
  const startedAt = Date.now();
  let databaseDurationMs: number | undefined;
  try {
    const user = await authenticateAIRequest(req);
    const queryStartedAt = Date.now();
    const websites = await prisma.website.findMany({
      where: { userId: user.id, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        title: true,
        type: true,
        status: true,
        revision: true,
        currentVersion: true,
        createdAt: true,
        updatedAt: true,
        versions: {
          orderBy: { version: 'desc' },
          take: 1,
          select: { id: true, version: true, source: true, summary: true, changeType: true, createdAt: true },
        },
        domains: { where: { kind: 'mento_subdomain', status: 'active' }, select: { hostname: true }, take: 1 },
      },
    });
    databaseDurationMs = Math.max(0, Date.now() - queryStartedAt);
    return listJsonResponse({ websites }, headers(req), {
      route: 'websites.list',
      status: 200,
      startedAt,
      recordCount: websites.length,
      databaseDurationMs,
    });
  } catch (error) {
    if (error instanceof AIRequestGatewayError) {
      return listJsonResponse(error.body, { ...error.headers, ...headers(req) }, {
        route: 'websites.list', status: error.status, startedAt, recordCount: 0, databaseDurationMs,
      });
    }
    return listJsonResponse({ error: 'Websites could not be loaded.' }, headers(req), {
      route: 'websites.list', status: 500, startedAt, recordCount: 0, databaseDurationMs,
    });
  }
}

export const runtime = 'nodejs';