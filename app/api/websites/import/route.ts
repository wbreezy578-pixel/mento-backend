import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../../lib/prisma';
import { AIRequestGatewayError, authenticateAIRequest, enforceAIGatewayRateLimit, getClientIp } from '../../../../lib/aiSecurityGateway';
import { readJsonBodyWithLimit, RequestBodyError } from '../../../../lib/requestBody';
import { buildCorsHeaders } from '../../../../lib/securityHeaders';
import { isWebsiteType, normalizeWebsiteContent } from '../../../../services/websiteContent';
import { createDraftWebsiteSlug } from '../../../../services/websiteDeploymentService';
import { assertWebsiteFeatureAccess, createWebsiteWithinProLimit, WebsiteAccessError } from '../../../../services/websiteBillingService';

const MAX_BODY_BYTES = 96 * 1024;

function headers(req: Request) {
  return { ...buildCorsHeaders(req.headers.get('origin')), 'Cache-Control': 'no-store, private' };
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': 'POST, OPTIONS' } });
}

export async function POST(req: Request) {
  try {
    const user = await authenticateAIRequest(req);
    await enforceAIGatewayRateLimit(user.id, getClientIp(req));
    let body: { type?: unknown; content?: unknown };
    try {
      body = await readJsonBodyWithLimit(req, MAX_BODY_BYTES);
    } catch (error) {
      const bodyError = error instanceof RequestBodyError ? error : new RequestBodyError('Invalid JSON body.', 400, 'invalid_json');
      return NextResponse.json({ error: bodyError.message, code: bodyError.code }, { status: bodyError.status, headers: headers(req) });
    }
    if (!isWebsiteType(body.type)) return NextResponse.json({ error: 'Choose a supported website type.' }, { status: 400, headers: headers(req) });
    const content = normalizeWebsiteContent(body.content);
    if (!content) return NextResponse.json({ error: 'The website content is outside the supported structure.' }, { status: 400, headers: headers(req) });
    const slug = createDraftWebsiteSlug(content.title);
    if (!slug) return NextResponse.json({ error: 'This website name cannot be used for a new draft.', code: 'invalid_website_slug' }, { status: 400, headers: headers(req) });
    await assertWebsiteFeatureAccess(user.id, 'create');

    const website = await createWebsiteWithinProLimit(user.id, (tx) => tx.website.create({
      data: {
        userId: user.id,
        type: body.type as string,
        title: content.title,
        slug,
        content: content as unknown as Prisma.InputJsonValue,
        currentVersion: 1,
        versions: {
          create: {
            version: 1,
            source: 'local_import',
            summary: 'Imported local draft',
            content: content as unknown as Prisma.InputJsonValue,
          },
        },
      },
      include: { versions: true },
    }));
    return NextResponse.json({ website }, { status: 201, headers: headers(req) });
  } catch (error) {
    if (error instanceof RequestBodyError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: headers(req) });
    if (error instanceof WebsiteAccessError) return NextResponse.json({ error: error.message }, { status: error.status, headers: headers(req) });
    if (error instanceof AIRequestGatewayError) return NextResponse.json(error.body, { status: error.status, headers: { ...error.headers, ...headers(req) } });
    return NextResponse.json({ error: 'Website draft could not be imported.' }, { status: 500, headers: headers(req) });
  }
}

export const runtime = 'nodejs';