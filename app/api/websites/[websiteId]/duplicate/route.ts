import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../../../lib/prisma';
import { AIRequestGatewayError, authenticateAIRequest, enforceAIGatewayRateLimit, getClientIp } from '../../../../../lib/aiSecurityGateway';
import { buildCorsHeaders } from '../../../../../lib/securityHeaders';
import { createDraftWebsiteSlug } from '../../../../../services/websiteDeploymentService';
import { assertWebsiteFeatureAccess, createWebsiteWithinProLimit, WebsiteAccessError } from '../../../../../services/websiteBillingService';

const MAX_BODY_BYTES = 4 * 1024;
type RouteContext = { params: Promise<{ websiteId: string }> };

function headers(req: Request) {
  return { ...buildCorsHeaders(req.headers.get('origin')), 'Cache-Control': 'no-store, private' };
}

export async function POST(req: Request, context: RouteContext) {
  try {
    const user = await authenticateAIRequest(req);
    await enforceAIGatewayRateLimit(user.id, getClientIp(req));
    const { websiteId } = await context.params;
    const website = await prisma.website.findFirst({ where: { id: websiteId, userId: user.id, deletedAt: null } });
    if (!website) return NextResponse.json({ error: 'Website not found.' }, { status: 404, headers: headers(req) });
    await assertWebsiteFeatureAccess(user.id, 'create');

    const title = `${website.title} Copy`;
    const slug = createDraftWebsiteSlug(title);
    if (!slug) return NextResponse.json({ error: 'This website name cannot be used for a new draft.', code: 'invalid_website_slug' }, { status: 400, headers: headers(req) });

    const duplicated = await createWebsiteWithinProLimit(user.id, (tx) => tx.website.create({
        data: {
          userId: user.id,
          type: website.type,
          title,
          slug,
          content: website.content as Prisma.InputJsonValue,
          status: 'draft',
          revision: 0,
          currentVersion: 1,
          versions: {
            create: {
              version: 1,
              source: 'duplicate',
              summary: 'Duplicated website',
              changeType: 'duplicate',
              createdBy: user.id,
              content: website.content as Prisma.InputJsonValue,
            },
          },
        },
        include: { versions: true },
      }));

    return NextResponse.json({ website: duplicated }, { status: 201, headers: headers(req) });
  } catch (error) {
    if (error instanceof WebsiteAccessError) return NextResponse.json({ error: error.message }, { status: error.status, headers: headers(req) });
    if (error instanceof AIRequestGatewayError) return NextResponse.json(error.body, { status: error.status, headers: { ...error.headers, ...headers(req) } });
    return NextResponse.json({ error: 'Website could not be duplicated.' }, { status: 500, headers: headers(req) });
  }
}

export const runtime = 'nodejs';
