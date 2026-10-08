import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { AIRequestGatewayError, authenticateAIRequest, enforceAIGatewayRateLimit, getClientIp } from '../../../../../../lib/aiSecurityGateway';
import { readJsonBodyWithLimit, RequestBodyError } from '../../../../../../lib/requestBody';
import { buildCorsHeaders } from '../../../../../../lib/securityHeaders';
import { prisma } from '../../../../../../lib/prisma';
import { normalizeWebsiteContent, type WebsiteContent } from '../../../../../../services/websiteContent';
import { getPexelsImageById } from '../../../../../../services/pexelsService';
import { buildWebsiteApiView } from '../../../../../../services/websiteAssetApi';
import { assertWebsiteFeatureAccess, WebsiteAccessError } from '../../../../../../services/websiteBillingService';

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
    const website = await prisma.website.findFirst({ where: { id: websiteId, userId: user.id } });
    if (!website) return NextResponse.json({ error: 'Website not found.' }, { status: 404, headers: headers(req) });
    await assertWebsiteFeatureAccess(user.id, 'edit');

    const body = await readJsonBodyWithLimit<{ slotId?: unknown; providerAssetId?: unknown; revision?: unknown }>(req, 2048);
    const slotId = typeof body.slotId === 'string' ? body.slotId : '';
    const providerAssetId = typeof body.providerAssetId === 'string' ? body.providerAssetId : '';
    if (body.revision !== website.revision) return NextResponse.json({ error: 'This website changed elsewhere. Reload it before selecting an image.', code: 'website_revision_conflict' }, { status: 409, headers: headers(req) });
    const content = normalizeWebsiteContent(website.content);
    const slotIndex = content?.imageSlots.findIndex((slot) => slot.id === slotId) ?? -1;
    if (!content || slotIndex < 0) return NextResponse.json({ error: 'Image slot not found.' }, { status: 404, headers: headers(req) });

    const photo = await getPexelsImageById(providerAssetId);
    if (!photo) return NextResponse.json({ error: 'That Pexels image was not found.' }, { status: 404, headers: headers(req) });
    const assetId = randomUUID();
    const nextContent: WebsiteContent = {
      ...content,
      imageSlots: content.imageSlots.map((slot, index) => index === slotIndex ? { ...slot, assetId } : slot),
    };
    const assetData = {
      id: assetId,
      websiteId,
      slotId,
      source: 'pexels',
      providerAssetId: photo.providerAssetId,
      objectKey: null,
      remoteUrl: photo.imageUrl,
      sourcePageUrl: photo.sourcePageUrl,
      creatorName: photo.creatorName,
      creatorProfileUrl: photo.creatorProfileUrl,
      alt: photo.alt || content.imageSlots[slotIndex].alt,
      mimeType: null,
      width: photo.width,
      height: photo.height,
    };

    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.website.updateMany({
        where: { id: websiteId, userId: user.id, revision: website.revision },
        data: { content: nextContent as unknown as Prisma.InputJsonValue, revision: { increment: 1 } },
      });
      if (changed.count !== 1) return null;
      await tx.websiteAsset.create({ data: assetData });
      return tx.website.findFirst({ where: { id: websiteId, userId: user.id } });
    });
    if (!updated) return NextResponse.json({ error: 'This website changed elsewhere. Reload it before selecting an image.', code: 'website_revision_conflict' }, { status: 409, headers: headers(req) });

    return NextResponse.json({ website: await buildWebsiteApiView(updated) }, { headers: headers(req) });
  } catch (error) {
    if (error instanceof RequestBodyError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: headers(req) });
    if (error instanceof WebsiteAccessError) return NextResponse.json({ error: error.message }, { status: error.status, headers: headers(req) });
    if (error instanceof AIRequestGatewayError) return NextResponse.json(error.body, { status: error.status, headers: { ...error.headers, ...headers(req) } });
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Image selection is unavailable.' }, { status: 503, headers: headers(req) });
  }
}

export const runtime = 'nodejs';