import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { AIRequestGatewayError, authenticateAIRequest, enforceAIGatewayRateLimit, getClientIp } from '../../../../../../lib/aiSecurityGateway';
import { readJsonBodyWithLimit, RequestBodyError } from '../../../../../../lib/requestBody';
import { buildCorsHeaders } from '../../../../../../lib/securityHeaders';
import { prisma } from '../../../../../../lib/prisma';
import { buildWebsiteApiView } from '../../../../../../services/websiteAssetApi';
import { normalizeWebsiteContent, type WebsiteContent } from '../../../../../../services/websiteContent';
import { assertWebsiteFeatureAccess, WebsiteAccessError } from '../../../../../../services/websiteBillingService';
import { getVerifiedUnsplashPhoto, trackUnsplashPhotoDownload, UnsplashSearchError } from '../../../../../../services/unsplashService';
import { isWebsTestingMode } from '../../../../../../services/websiteTestingMode';
import logger from '../../../../../../lib/logger';

type RouteContext = { params: Promise<{ websiteId: string }> };
const MAX_BODY_BYTES = 2 * 1024;

function headers(req: Request) {
  return { ...buildCorsHeaders(req.headers.get('origin')), 'Cache-Control': 'no-store, private' };
}

function errorResponse(req: Request, message: string, status: number, code: string) {
  return NextResponse.json({ error: message, code }, { status, headers: headers(req) });
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': 'POST, OPTIONS' },
  });
}

export async function POST(req: Request, context: RouteContext) {
  try {
    const user = await authenticateAIRequest(req);
    await enforceAIGatewayRateLimit(user.id, getClientIp(req));
    const { websiteId } = await context.params;
    const body = await readJsonBodyWithLimit<{
      slotId?: unknown;
      photoId?: unknown;
      revision?: unknown;
      role?: unknown;
      targetId?: unknown;
      query?: unknown;
      alt?: unknown;
    }>(req, MAX_BODY_BYTES);
    if (
      typeof body.slotId !== 'string'
      || !/^[A-Za-z0-9_-]{1,80}$/.test(body.slotId)
      || typeof body.photoId !== 'string'
      || !/^[A-Za-z0-9_-]{1,200}$/.test(body.photoId)
      || !Number.isSafeInteger(body.revision)
    ) {
      return errorResponse(req, 'Choose a valid photo and website image slot.', 400, 'invalid_photo_selection');
    }

    const website = await prisma.website.findFirst({
      where: { id: websiteId, userId: user.id, deletedAt: null },
      select: { id: true, userId: true, revision: true, currentVersion: true, content: true },
    });
    if (!website) return errorResponse(req, 'Website not found.', 404, 'website_not_found');
    if (!isWebsTestingMode()) return errorResponse(req, 'Not found.', 404, 'not_found');
    await assertWebsiteFeatureAccess(user.id, 'edit');
    if (body.revision !== website.revision) {
      return errorResponse(req, 'This website changed elsewhere. Reload it before choosing a photo.', 409, 'website_revision_conflict');
    }
    const currentContent = normalizeWebsiteContent(website.content);
    if (!currentContent) return errorResponse(req, 'This website draft needs repair before it can accept images.', 409, 'invalid_website_content');
    const existingSlot = currentContent.imageSlots.find((candidate) => candidate.id === body.slotId);
    let slot = existingSlot;
    let contentWithSlot = currentContent;
    if (!slot) {
      if (
        currentContent.imageSlots.length >= 8
        || !['hero', 'gallery', 'menu_item', 'section'].includes(String(body.role))
        || typeof body.query !== 'string' || !body.query.trim() || body.query.length > 180
        || typeof body.alt !== 'string' || !body.alt.trim() || body.alt.length > 180
        || (body.targetId !== null && body.targetId !== undefined
          && (typeof body.targetId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(body.targetId)))
      ) return errorResponse(req, 'Image slot not found or invalid.', 404, 'image_slot_not_found');
      const role = body.role as WebsiteContent['imageSlots'][number]['role'];
      const targetId = typeof body.targetId === 'string' ? body.targetId : null;
      const targetSection = targetId
        ? currentContent.pages.flatMap((page) => page.sections).find((section) => section.id === targetId)
        : undefined;
      const targetMenuItem = targetId
        ? currentContent.menuCategories.flatMap((category) => category.items).find((item) => item.id === targetId)
        : undefined;
      const validTarget = role === 'menu_item'
        ? Boolean(targetMenuItem)
        : role === 'hero'
          ? targetSection?.type === 'hero'
          : role === 'gallery'
            ? targetSection?.type === 'gallery'
            : ['about', 'services'].includes(targetSection?.type ?? '');
      if (!validTarget) return errorResponse(req, 'Choose an image section that still exists in this website.', 400, 'invalid_image_target');
      slot = {
        id: body.slotId,
        role,
        targetId,
        query: body.query.trim(),
        alt: body.alt.trim(),
        assetId: null,
      };
      contentWithSlot = {
        ...currentContent,
        imageSlots: [...currentContent.imageSlots, slot],
        pages: currentContent.pages.map((page) => ({
          ...page,
          sections: page.sections.map((section) => section.id === targetId ? { ...section, imageSlotId: slot!.id } : section),
        })),
        menuCategories: currentContent.menuCategories.map((category) => ({
          ...category,
          items: category.items.map((item) => item.id === targetId ? { ...item, imageSlotId: slot!.id } : item),
        })),
      };
    }

    const photo = await getVerifiedUnsplashPhoto(body.photoId);
    const assetId = randomUUID();
    const nextContent: WebsiteContent = {
      ...contentWithSlot,
      imageSlots: contentWithSlot.imageSlots.map((candidate) => candidate.id === slot!.id
        ? { ...candidate, assetId }
        : candidate),
    };
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.website.updateMany({
        where: { id: websiteId, userId: user.id, revision: website.revision },
        data: { content: nextContent as unknown as Prisma.InputJsonValue, revision: { increment: 1 } },
      });
      if (changed.count !== 1) return null;
      await tx.websiteAsset.create({
        data: {
          id: assetId,
          websiteId,
          slotId: slot.id,
          version: website.currentVersion,
          source: 'unsplash',
          providerAssetId: photo.id,
          objectKey: null,
          remoteUrl: photo.imageUrl,
          providerImageUrl: photo.imageUrl,
          providerTags: [],
          searchQuery: slot.query,
          retrievedAt: new Date(),
          licenseName: 'Unsplash License',
          licenseUrl: 'https://unsplash.com/license',
          attributionRequired: true,
          sourcePageUrl: photo.sourcePageUrl,
          creatorName: photo.creatorName,
          creatorProfileUrl: photo.creatorProfileUrl,
          alt: slot.alt || photo.alt,
          mimeType: 'image/jpeg',
          width: photo.width || null,
          height: photo.height || null,
        },
      });
      return tx.website.findFirst({ where: { id: websiteId, userId: user.id } });
    });
    if (!updated) return errorResponse(req, 'This website changed elsewhere. Reload it before choosing a photo.', 409, 'website_revision_conflict');

    try {
      await trackUnsplashPhotoDownload(photo.downloadLocation);
    } catch (error) {
      logger.error('Unsplash download tracking failed after editor photo selection', {
        category: 'unsplash_download_tracking_failed',
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
    return NextResponse.json({ website: await buildWebsiteApiView(updated) }, { status: 200, headers: headers(req) });
  } catch (error) {
    if (error instanceof RequestBodyError) return errorResponse(req, error.message, error.status, error.code);
    if (error instanceof AIRequestGatewayError) return NextResponse.json(error.body, { status: error.status, headers: { ...error.headers, ...headers(req) } });
    if (error instanceof WebsiteAccessError) return errorResponse(req, error.message, error.status, 'website_pro_required');
    if (error instanceof UnsplashSearchError) {
      const unavailable = error.kind !== 'invalid_response';
      return NextResponse.json({
        error: unavailable
          ? 'Mento photos are temporarily unavailable. Try again shortly.'
          : 'That photo is no longer available. Search again and choose another photo.',
        code: unavailable ? 'photo_provider_unavailable' : 'unsplash_photo_unavailable',
        retryable: unavailable,
      }, {
        status: unavailable ? (error.kind === 'rate_limited' || error.kind === 'demo_rate_limited' ? 429 : 503) : 422,
        headers: {
          ...headers(req),
          ...(error.retryAfterSec ? { 'Retry-After': String(Math.ceil(error.retryAfterSec)) } : {}),
        },
      });
    }
    logger.error('Website Unsplash photo selection failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorMessage: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    });
    return errorResponse(req, 'The selected photo could not be saved. Your current image has not been changed.', 503, 'photo_selection_unavailable');
  }
}

export const runtime = 'nodejs';
