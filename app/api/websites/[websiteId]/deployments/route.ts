import { NextResponse } from 'next/server';
import { prisma } from '../../../../../lib/prisma';
import { AIRequestGatewayError, authenticateAIRequest } from '../../../../../lib/aiSecurityGateway';
import { buildCorsHeaders } from '../../../../../lib/securityHeaders';

type RouteContext = { params: Promise<{ websiteId: string }> };

function headers(req: Request) {
  return { ...buildCorsHeaders(req.headers.get('origin')), 'Cache-Control': 'no-store, private' };
}

export async function GET(req: Request, context: RouteContext) {
  try {
    const user = await authenticateAIRequest(req);
    const { websiteId } = await context.params;
    const website = await prisma.website.findFirst({ where: { id: websiteId, userId: user.id, deletedAt: null }, select: { id: true } });
    if (!website) return NextResponse.json({ error: 'Website not found.' }, { status: 404, headers: headers(req) });

    const deployments = await prisma.websiteDeployment.findMany({
      where: { websiteId },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json({ deployments }, { headers: headers(req) });
  } catch (error) {
    if (error instanceof AIRequestGatewayError) return NextResponse.json(error.body, { status: error.status, headers: { ...error.headers, ...headers(req) } });
    return NextResponse.json({ error: 'Website deployments could not be loaded.' }, { status: 500, headers: headers(req) });
  }
}

export const runtime = 'nodejs';
