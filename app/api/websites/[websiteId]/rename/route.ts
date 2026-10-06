import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../../../lib/prisma';
import { AIRequestGatewayError, authenticateAIRequest, enforceAIGatewayRateLimit, getClientIp } from '../../../../../lib/aiSecurityGateway';
import { readJsonBodyWithLimit, RequestBodyError } from '../../../../../lib/requestBody';
import { buildCorsHeaders } from '../../../../../lib/securityHeaders';
import { isWebsiteSlugUniqueConstraintError, slugifyWebsiteName } from '../../../../../services/websiteDeploymentService';
import { assertWebsiteFeatureAccess, WebsiteAccessError } from '../../../../../services/websiteBillingService';

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
    let body: { name?: unknown };
    try {
      body = await readJsonBodyWithLimit(req, MAX_BODY_BYTES);
    } catch (error) {
      const bodyError = error instanceof RequestBodyError ? error : new RequestBodyError('Invalid JSON body.', 400, 'invalid_json');
      return NextResponse.json({ error: bodyError.message, code: bodyError.code }, { status: bodyError.status, headers: headers(req) });
    }

    const title = typeof body.name === 'string' ? body.name.trim() : '';
    if (!title || title.length > 120) {
      return NextResponse.json({ error: 'Enter a website name between 1 and 120 characters.', code: 'invalid_website_name' }, { status: 400, headers: headers(req) });
    }
    const slug = slugifyWebsiteName(title);
    if (!slug) {
      return NextResponse.json({ error: 'Choose a website name that can be used in a website address.', code: 'invalid_website_slug' }, { status: 400, headers: headers(req) });
    }

    const website = await prisma.website.findFirst({ where: { id: websiteId, userId: user.id, deletedAt: null } });
    if (!website) return NextResponse.json({ error: 'Website not found.' }, { status: 404, headers: headers(req) });
    await assertWebsiteFeatureAccess(user.id, 'edit');

    if (slug !== website.slug) {
      const conflictingWebsite = await prisma.website.findFirst({
        where: { slug, id: { not: websiteId } },
        select: { id: true },
      });
      if (conflictingWebsite) {
        return NextResponse.json({ error: 'That website address is already in use. Choose a different website name.', code: 'website_slug_conflict' }, { status: 409, headers: headers(req) });
      }
    }

    const nextVersion = website.currentVersion + 1;
    const renamed = await prisma.$transaction(async (tx) => {
      const updated = await tx.website.update({
        where: { id: websiteId },
        data: {
          title,
          slug,
          currentVersion: nextVersion,
          updatedAt: new Date(),
        },
      });
      const version = await tx.websiteVersion.create({
        data: {
          websiteId,
          version: nextVersion,
          source: 'rename',
          summary: `Renamed website to ${title}`,
          changeType: 'rename',
          createdBy: user.id,
          content: website.content as Prisma.InputJsonValue,
        },
      });
      return { website: updated, version };
    });

    return NextResponse.json({ website: renamed.website, version: renamed.version }, { headers: headers(req) });
  } catch (error) {
    if (error instanceof RequestBodyError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: headers(req) });
    if (error instanceof WebsiteAccessError) return NextResponse.json({ error: error.message }, { status: error.status, headers: headers(req) });
    if (error instanceof AIRequestGatewayError) return NextResponse.json(error.body, { status: error.status, headers: { ...error.headers, ...headers(req) } });
    if (isWebsiteSlugUniqueConstraintError(error)) {
      return NextResponse.json({ error: 'That website address is already in use. Choose a different website name.', code: 'website_slug_conflict' }, { status: 409, headers: headers(req) });
    }
    return NextResponse.json({ error: 'Website could not be renamed.' }, { status: 500, headers: headers(req) });
  }
}

export const runtime = 'nodejs';
