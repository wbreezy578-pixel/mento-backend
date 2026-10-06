import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../../../lib/prisma';
import { AIRequestGatewayError, authenticateAIRequest, enforceAIGatewayRateLimit, getClientIp } from '../../../../../lib/aiSecurityGateway';
import { readJsonBodyWithLimit, RequestBodyError } from '../../../../../lib/requestBody';
import { buildCorsHeaders } from '../../../../../lib/securityHeaders';
import { normalizeWebsiteContent } from '../../../../../services/websiteContent';
import { assertWebsiteFeatureAccess, WebsiteAccessError } from '../../../../../services/websiteBillingService';

type RouteContext = { params: Promise<{ websiteId: string }> };

function headers(req: Request) {
  return { ...buildCorsHeaders(req.headers.get('origin')), 'Cache-Control': 'no-store, private' };
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': 'POST, OPTIONS' } });
}

export async function POST(req: Request, context: RouteContext) {
  try {
    const user = await authenticateAIRequest(req);
    await enforceAIGatewayRateLimit(user.id, getClientIp(req));
    const { websiteId } = await context.params;
    const website = await prisma.website.findFirst({ where: { id: websiteId, userId: user.id }, select: { id: true, revision: true, type: true } });
    if (!website) return NextResponse.json({ error: 'Website not found.' }, { status: 404, headers: headers(req) });
    await assertWebsiteFeatureAccess(user.id, 'edit');

    let body: { version?: unknown; revision?: unknown };
    try {
      body = await readJsonBodyWithLimit(req, 1024);
    } catch (error) {
      const bodyError = error instanceof RequestBodyError ? error : new RequestBodyError('Invalid JSON body.', 400, 'invalid_json');
      return NextResponse.json({ error: bodyError.message, code: bodyError.code }, { status: bodyError.status, headers: headers(req) });
    }
    if (!Number.isSafeInteger(body.version) || (body.version as number) < 1 || body.revision !== website.revision) {
      if (body.revision !== website.revision) return NextResponse.json({ error: 'This website changed elsewhere. Reload it before restoring a version.', code: 'website_revision_conflict' }, { status: 409, headers: headers(req) });
      return NextResponse.json({ error: 'Choose a valid version to restore.' }, { status: 400, headers: headers(req) });
    }

    const sourceVersion = await prisma.websiteVersion.findFirst({ where: { websiteId, version: body.version as number } });
    const content = sourceVersion ? normalizeWebsiteContent(sourceVersion.content) : null;
    if (!sourceVersion || !content) return NextResponse.json({ error: 'That website version was not found.' }, { status: 404, headers: headers(req) });

    const result = await prisma.$transaction(async (tx) => {
      const restoredWebsite = await tx.website.update({
        where: { id: websiteId, userId: user.id, revision: website.revision },
        data: {
          type: website.type,
          title: content.title,
          content: content as unknown as Prisma.InputJsonValue,
          revision: { increment: 1 },
          currentVersion: { increment: 1 },
        },
      });
      const restoredVersion = await tx.websiteVersion.create({
        data: {
          websiteId,
          version: restoredWebsite.currentVersion,
          source: 'restore',
          summary: `Restored version ${sourceVersion.version}`,
          content: content as unknown as Prisma.InputJsonValue,
        },
      });
      return { website: restoredWebsite, version: restoredVersion };
    });

    return NextResponse.json(result, { headers: headers(req) });
  } catch (error) {
    if (error instanceof RequestBodyError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: headers(req) });
    if (error instanceof WebsiteAccessError) return NextResponse.json({ error: error.message }, { status: error.status, headers: headers(req) });
    if (error instanceof AIRequestGatewayError) return NextResponse.json(error.body, { status: error.status, headers: { ...error.headers, ...headers(req) } });
    return NextResponse.json({ error: 'Website version could not be restored.' }, { status: 500, headers: headers(req) });
  }
}

export const runtime = 'nodejs';