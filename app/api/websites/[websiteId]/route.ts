import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../../lib/prisma';
import { AIRequestGatewayError, authenticateAIRequest, enforceAIGatewayRateLimit, getClientIp } from '../../../../lib/aiSecurityGateway';
import { readJsonBodyWithLimit, RequestBodyError } from '../../../../lib/requestBody';
import { buildCorsHeaders } from '../../../../lib/securityHeaders';
import { isWebsiteType, normalizeWebsiteContent } from '../../../../services/websiteContent';
import { assertWebsiteFeatureAccess, WebsiteAccessError } from '../../../../services/websiteBillingService';

type RouteContext = { params: Promise<{ websiteId: string }> };
const MAX_BODY_BYTES = 96 * 1024;
const CORS_METHODS = 'GET, PATCH, DELETE, OPTIONS';

function headers(req: Request) {
  return { ...buildCorsHeaders(req.headers.get('origin')), 'Cache-Control': 'no-store, private' };
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
}

export async function GET(req: Request, context: RouteContext) {
  try {
    const user = await authenticateAIRequest(req);
    const { websiteId } = await context.params;
    const website = await prisma.website.findFirst({
      where: { id: websiteId, userId: user.id, deletedAt: null },
      include: {
        versions: { orderBy: { version: 'desc' }, take: 30, select: { id: true, version: true, source: true, summary: true, changeType: true, createdAt: true } },
        domains: { where: { kind: 'mento_subdomain', status: 'active' }, select: { hostname: true }, take: 1 },
      },
    });
    if (!website) return NextResponse.json({ error: 'Website not found.' }, { status: 404, headers: headers(req) });
    return NextResponse.json({ website }, { headers: headers(req) });
  } catch (error) {
    if (error instanceof AIRequestGatewayError) return NextResponse.json(error.body, { status: error.status, headers: { ...error.headers, ...headers(req) } });
    return NextResponse.json({ error: 'Website could not be loaded.' }, { status: 500, headers: headers(req) });
  }
}

export async function PATCH(req: Request, context: RouteContext) {
  try {
    const user = await authenticateAIRequest(req);
    await enforceAIGatewayRateLimit(user.id, getClientIp(req));
    const { websiteId } = await context.params;
    let body: { content?: unknown; revision?: unknown; type?: unknown };
    try {
      body = await readJsonBodyWithLimit(req, MAX_BODY_BYTES);
    } catch (error) {
      const bodyError = error instanceof RequestBodyError ? error : new RequestBodyError('Invalid JSON body.', 400, 'invalid_json');
      return NextResponse.json({ error: bodyError.message, code: bodyError.code }, { status: bodyError.status, headers: headers(req) });
    }

    if (typeof body.revision !== 'number' || !Number.isSafeInteger(body.revision) || !isWebsiteType(body.type)) {
      return NextResponse.json({ error: 'The website revision or type is invalid.' }, { status: 400, headers: headers(req) });
    }
    const revision = body.revision;
    const type = body.type;
    const content = normalizeWebsiteContent(body.content);
    if (!content) return NextResponse.json({ error: 'The website content is outside the supported structure.' }, { status: 400, headers: headers(req) });

    const ownedWebsite = await prisma.website.findFirst({ where: { id: websiteId, userId: user.id, deletedAt: null }, select: { id: true } });
    if (!ownedWebsite) return NextResponse.json({ error: 'Website not found.' }, { status: 404, headers: headers(req) });
    await assertWebsiteFeatureAccess(user.id, 'edit');

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.website.updateMany({
        where: { id: websiteId, userId: user.id, deletedAt: null, revision, type },
        data: {
          title: content.title,
          content: content as unknown as Prisma.InputJsonValue,
          revision: { increment: 1 },
          currentVersion: { increment: 1 },
        },
      });
      if (updated.count === 0) return null;
      const latest = await tx.website.findFirst({
        where: { id: websiteId, userId: user.id, deletedAt: null },
        select: { currentVersion: true },
      });
      if (!latest) throw new Error('Updated website could not be loaded.');
      const version = await tx.websiteVersion.create({
        data: {
          websiteId,
          version: latest.currentVersion,
          source: 'manual_edit',
          summary: 'Saved website changes',
          content: content as unknown as Prisma.InputJsonValue,
        },
      });
      const website = await tx.website.findFirst({
        where: { id: websiteId, userId: user.id, deletedAt: null },
        include: {
          domains: { where: { kind: 'mento_subdomain', status: 'active' }, select: { hostname: true }, take: 1 },
        },
      });
      if (!website) throw new Error('Updated website could not be loaded.');
      return { website, version };
    });
    if (!result) {
      const exists = await prisma.website.findFirst({ where: { id: websiteId, userId: user.id, deletedAt: null }, select: { id: true } });
      return NextResponse.json({ error: exists ? 'This website changed elsewhere. Reload it before saving.' : 'Website not found.', code: exists ? 'website_revision_conflict' : 'website_not_found' }, { status: exists ? 409 : 404, headers: headers(req) });
    }

    return NextResponse.json(result, { headers: headers(req) });
  } catch (error) {
    if (error instanceof RequestBodyError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: headers(req) });
    if (error instanceof WebsiteAccessError) return NextResponse.json({ error: error.message }, { status: error.status, headers: headers(req) });
    if (error instanceof AIRequestGatewayError) return NextResponse.json(error.body, { status: error.status, headers: { ...error.headers, ...headers(req) } });
    return NextResponse.json({ error: 'Website could not be saved.' }, { status: 500, headers: headers(req) });
  }
}

export async function DELETE(req: Request, context: RouteContext) {
  try {
    const user = await authenticateAIRequest(req);
    const { websiteId } = await context.params;
    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      const deleted = await tx.website.updateMany({
        where: { id: websiteId, userId: user.id, deletedAt: null },
        data: {
          deletedAt: now,
          status: 'archived',
          publishedVersion: null,
          publishedDeploymentId: null,
          updatedAt: now,
        },
      });
      if (deleted.count > 0) {
        await tx.websiteDeployment.updateMany({
          where: { websiteId, status: 'published' },
          data: { status: 'deleted', unpublishedAt: now },
        });
        await tx.websiteDomain.updateMany({
          where: { websiteId, status: 'active' },
          data: { status: 'disabled' },
        });
      }
      return deleted;
    });
    if (result.count === 0) return NextResponse.json({ error: 'Website not found.' }, { status: 404, headers: headers(req) });
    return new NextResponse(null, { status: 204, headers: headers(req) });
  } catch (error) {
    if (error instanceof AIRequestGatewayError) return NextResponse.json(error.body, { status: error.status, headers: { ...error.headers, ...headers(req) } });
    return NextResponse.json({ error: 'Website could not be deleted.' }, { status: 500, headers: headers(req) });
  }
}

export const runtime = 'nodejs';