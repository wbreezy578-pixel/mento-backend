import { NextResponse } from 'next/server';
import { prisma } from '../../../../../lib/prisma';
import { AIRequestGatewayError, authenticateAIRequest, enforceAIGatewayRateLimit, getClientIp } from '../../../../../lib/aiSecurityGateway';
import { readJsonBodyWithLimit, RequestBodyError } from '../../../../../lib/requestBody';
import { buildCorsHeaders } from '../../../../../lib/securityHeaders';

const MAX_BODY_BYTES = 8 * 1024;
type RouteContext = { params: Promise<{ websiteId: string }> };

function headers(req: Request) {
  return { ...buildCorsHeaders(req.headers.get('origin')), 'Cache-Control': 'no-store, private' };
}

export async function POST(req: Request, context: RouteContext) {
  try {
    const user = await authenticateAIRequest(req);
    await enforceAIGatewayRateLimit(user.id, getClientIp(req));
    const { websiteId } = await context.params;

    let body: { revision?: unknown };
    try {
      body = await readJsonBodyWithLimit(req, MAX_BODY_BYTES);
    } catch (error) {
      const bodyError = error instanceof RequestBodyError ? error : new RequestBodyError('Invalid JSON body.', 400, 'invalid_json');
      return NextResponse.json({ error: bodyError.message, code: bodyError.code }, { status: bodyError.status, headers: headers(req) });
    }

    const website = await prisma.website.findFirst({
      where: { id: websiteId, userId: user.id, deletedAt: null },
      select: { id: true, userId: true, revision: true, status: true },
    });
    if (!website) return NextResponse.json({ error: 'Website not found.' }, { status: 404, headers: headers(req) });

    if (body.revision !== undefined && (!Number.isSafeInteger(body.revision) || (body.revision as number) !== website.revision)) {
      return NextResponse.json({ error: 'This website changed elsewhere. Reload it before unpublishing.', code: 'website_revision_conflict' }, { status: 409, headers: headers(req) });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.website.findFirst({
        where: { id: websiteId, userId: user.id, deletedAt: null },
        select: { publishedDeploymentId: true },
      });
      const now = new Date();
      if (current?.publishedDeploymentId) {
        await tx.websiteDeployment.updateMany({
          where: { id: current.publishedDeploymentId, websiteId, status: 'published' },
          data: { status: 'paused', unpublishedAt: now },
        });
      }
      await tx.websiteDomain.updateMany({
        where: { websiteId, status: 'active' },
        data: { status: 'disabled' },
      });
      return tx.website.update({
        where: { id: websiteId, userId: user.id },
        data: {
          status: 'draft',
          publishedVersion: null,
          publishedDeploymentId: null,
          updatedAt: now,
        },
      });
    });

    return NextResponse.json({ website: updated }, { headers: headers(req) });
  } catch (error) {
    if (error instanceof RequestBodyError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: headers(req) });
    if (error instanceof AIRequestGatewayError) return NextResponse.json(error.body, { status: error.status, headers: { ...error.headers, ...headers(req) } });
    return NextResponse.json({ error: 'Website could not be unpublished.' }, { status: 500, headers: headers(req) });
  }
}

export const runtime = 'nodejs';
