import { NextResponse } from 'next/server';
import { prisma } from '../../../lib/prisma';
import { AIRequestGatewayError, authenticateAIRequest } from '../../../lib/aiSecurityGateway';
import { buildCorsHeaders } from '../../../lib/securityHeaders';

function headers(req: Request) {
  return { ...buildCorsHeaders(req.headers.get('origin')), 'Cache-Control': 'no-store, private' };
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
}

export async function GET(req: Request) {
  try {
    const user = await authenticateAIRequest(req);
    const websites = await prisma.website.findMany({
      where: { userId: user.id, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      include: {
        versions: {
          orderBy: { version: 'desc' },
          take: 1,
          select: { id: true, version: true, source: true, summary: true, changeType: true, createdAt: true },
        },
        domains: { where: { kind: 'mento_subdomain', status: 'active' }, select: { hostname: true }, take: 1 },
      },
    });
    return NextResponse.json({ websites }, { headers: headers(req) });
  } catch (error) {
    if (error instanceof AIRequestGatewayError) return NextResponse.json(error.body, { status: error.status, headers: { ...error.headers, ...headers(req) } });
    return NextResponse.json({ error: 'Websites could not be loaded.' }, { status: 500, headers: headers(req) });
  }
}

export const runtime = 'nodejs';