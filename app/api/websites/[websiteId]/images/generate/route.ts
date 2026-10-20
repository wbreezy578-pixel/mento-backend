import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import {
  AIRequestGatewayError,
  authenticateAIRequest,
  enforceAIGatewayRateLimit,
  getClientIp,
  requireClientAIRequestId,
  secureAITextInput,
} from '../../../../../../lib/aiSecurityGateway';
import { buildCorsHeaders } from '../../../../../../lib/securityHeaders';
import { prisma } from '../../../../../../lib/prisma';
import { readJsonBodyWithLimit, RequestBodyError } from '../../../../../../lib/requestBody';
import { buildWebsiteApiView } from '../../../../../../services/websiteAssetApi';
import {
  deletePrivateWebsiteUpload,
  savePrivateWebsiteUpload,
} from '../../../../../../services/websiteAssetService';
import { normalizeWebsiteContent, type WebsiteContent } from '../../../../../../services/websiteContent';
import { uploadPrivateWebsiteAssetToR2, deletePrivateWebsiteAssetFromR2 } from '../../../../../../services/websiteDeploymentStorage';
import { assertWebsiteFeatureAccess, WebsiteAccessError } from '../../../../../../services/websiteBillingService';
import { isWebsTestingMode } from '../../../../../../services/websiteTestingMode';
import {
  WebsiteImageGenerationError,
  buildWebsiteImagePrompt,
  generateWebsiteImage,
} from '../../../../../../services/imagenWebsiteGenerationService';
import {
  completeWebsiteImageGenerationReservation,
  getWebsiteImageGenerationUsage,
  releaseWebsiteImageGenerationReservation,
  reserveWebsiteImageGeneration,
  WebsiteImageGenerationQuotaError,
} from '../../../../../../services/websiteImageGenerationQuota';
import logger from '../../../../../../lib/logger';

type RouteContext = { params: Promise<{ websiteId: string }> };
const MAX_BODY_BYTES = 4 * 1024;
const MAX_PROMPT_LENGTH = 600;
const MAX_IMAGE_SLOTS = 32;
const ROLES = new Set(['hero', 'gallery', 'menu_item', 'section']);
const CORS_METHODS = 'GET, POST, OPTIONS';

function headers(req: Request) {
  return { ...buildCorsHeaders(req.headers.get('origin')), 'Cache-Control': 'no-store, private' };
}

function errorResponse(req: Request, message: string, status: number, code: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: message, code, ...extra }, { status, headers: headers(req) });
}

function aspectRatio(role: string): '1:1' | '3:4' | '4:3' | '9:16' | '16:9' {
  if (role === 'menu_item' || role === 'gallery') return '4:3';
  return '16:9';
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS },
  });
}

export async function GET(req: Request, context: RouteContext) {
  try {
    const user = await authenticateAIRequest(req);
    const { websiteId } = await context.params;
    const website = await prisma.website.findFirst({
      where: { id: websiteId, userId: user.id, deletedAt: null },
      select: { id: true },
    });
    if (!website) return errorResponse(req, 'Website not found.', 404, 'website_not_found');
    const imageGeneration = await getWebsiteImageGenerationUsage(user.id);
    return NextResponse.json({ imageGeneration }, { headers: headers(req) });
  } catch (error) {
    if (error instanceof AIRequestGatewayError) return NextResponse.json(error.body, { status: error.status, headers: { ...error.headers, ...headers(req) } });
    logger.error('Website image-generation allowance could not be loaded', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return errorResponse(req, 'Image-generation allowance details could not be loaded.', 500, 'website_image_generation_usage_unavailable');
  }
}

export async function POST(req: Request, context: RouteContext) {
  let userId: string | null = null;
  let reservationId: string | null = null;
  let uploadedObjectKey: string | null = null;
  let uploadedR2ObjectKey: string | null = null;
  let persisted = false;
  try {
    const user = await authenticateAIRequest(req);
    userId = user.id;
    const clientIp = getClientIp(req);
    await enforceAIGatewayRateLimit(user.id, clientIp);
    const body = await readJsonBodyWithLimit<{
      slotId?: unknown;
      role?: unknown;
      targetId?: unknown;
      prompt?: unknown;
      revision?: unknown;
      requestId?: unknown;
    }>(req, MAX_BODY_BYTES);
    if (
      !body
      || typeof body.slotId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(body.slotId)
      || typeof body.role !== 'string' || !ROLES.has(body.role)
      || (body.targetId !== null && body.targetId !== undefined
        && (typeof body.targetId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(body.targetId)))
      || !Number.isSafeInteger(body.revision)
      || (body.prompt !== undefined && (typeof body.prompt !== 'string' || body.prompt.length > MAX_PROMPT_LENGTH))
    ) return errorResponse(req, 'Choose a valid image slot and provide a short generation prompt.', 400, 'invalid_image_generation_request');

    const requestId = requireClientAIRequestId(req, body.requestId);
    const { websiteId } = await context.params;
    const website = await prisma.website.findFirst({
      where: { id: websiteId, userId: user.id, deletedAt: null },
      select: { id: true, userId: true, title: true, type: true, revision: true, currentVersion: true, content: true },
    });
    if (!website) return errorResponse(req, 'Website not found.', 404, 'website_not_found');
    await assertWebsiteFeatureAccess(user.id, 'edit');
    if (body.revision !== website.revision) {
      return errorResponse(req, 'This website changed elsewhere. Reload it before generating an image.', 409, 'website_revision_conflict');
    }
    const currentContent = normalizeWebsiteContent(website.content);
    if (!currentContent) return errorResponse(req, 'This website draft needs repair before it can accept images.', 409, 'invalid_website_content');

    const role = body.role as WebsiteContent['imageSlots'][number]['role'];
    const targetId = typeof body.targetId === 'string' ? body.targetId : null;
    let contentWithSlot = currentContent;
    let slot = currentContent.imageSlots.find((candidate) => candidate.id === body.slotId);
    if (slot && (slot.role !== role || slot.targetId !== targetId)) {
      return errorResponse(req, 'This image slot no longer matches the selected section.', 409, 'invalid_image_target');
    }
    if (!slot) {
      if (currentContent.imageSlots.length >= MAX_IMAGE_SLOTS) {
        return errorResponse(req, 'This website has reached its image-slot limit.', 409, 'image_slot_limit_reached');
      }
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
      const label = role === 'menu_item' ? targetMenuItem?.name : targetSection?.title;
      slot = {
        id: body.slotId,
        role,
        targetId,
        query: (typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim() : label ?? website.title).slice(0, 180),
        alt: (label ?? website.title).slice(0, 180),
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

    const ownerPrompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const designPreferences = currentContent.designPreferences;
    const designBrief = JSON.stringify(designPreferences);
    const safeInput = await secureAITextInput({
      userId: user.id,
      requestId,
      ip: clientIp,
      input: [website.title, slot.query, slot.alt, ownerPrompt, designBrief].filter(Boolean).join('\n'),
    });
    const safeImageDescription = safeInput.sanitizedInput
      ?? [website.title, slot.query, slot.alt, ownerPrompt, designBrief].filter(Boolean).join('\n');
    const prompt = buildWebsiteImagePrompt({
      businessName: website.title,
      businessType: website.type,
      imageDescription: safeImageDescription,
      designStyle: `${designPreferences.designPreset.replace(/-/g, ' ')}; ${designPreferences.backgroundStyle} palette; ${designPreferences.heroImageMode} hero-photo layout; ${designPreferences.overlayStrength} overlay; ${designPreferences.imageCrop} crop`,
      userPrompt: '',
    });
    const reserved = await reserveWebsiteImageGeneration(user.id);
    reservationId = reserved.reservationId;
    const generatedImage = await generateWebsiteImage({ prompt, aspectRatio: aspectRatio(role) });
    const usage = await completeWebsiteImageGenerationReservation(user.id, reservationId);
    reservationId = null;

    const stored = await savePrivateWebsiteUpload({
      userId: user.id,
      websiteId,
      buffer: generatedImage.buffer,
      mimeType: generatedImage.mimeType,
    });
    uploadedObjectKey = stored.objectKey;
    const assetId = randomUUID();
    if (!isWebsTestingMode()) {
      uploadedR2ObjectKey = await uploadPrivateWebsiteAssetToR2({
        websiteId,
        assetId,
        buffer: stored.buffer,
      });
    }
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
          slotId: slot!.id,
          version: website.currentVersion,
          source: 'gemini_generated',
          providerAssetId: null,
          objectKey: stored.objectKey,
          r2ObjectKey: uploadedR2ObjectKey,
          remoteUrl: null,
          providerImageUrl: null,
          providerTags: [],
          searchQuery: slot!.query,
          retrievedAt: new Date(),
          licenseName: 'Google Gemini-generated',
          licenseUrl: null,
          attributionRequired: false,
          sourcePageUrl: null,
          creatorName: null,
          creatorProfileUrl: null,
          alt: slot!.alt,
          mimeType: stored.mimeType,
          width: stored.width,
          height: stored.height,
        },
      });
      return tx.website.findFirst({ where: { id: websiteId, userId: user.id } });
    });
    if (!updated) {
      await deletePrivateWebsiteUpload(uploadedObjectKey);
      if (uploadedR2ObjectKey) await deletePrivateWebsiteAssetFromR2(uploadedR2ObjectKey);
      uploadedObjectKey = null;
      uploadedR2ObjectKey = null;
      return errorResponse(req, 'The image was generated, but the website changed before it could be saved. Reload and try again.', 409, 'website_revision_conflict', { imageGeneration: usage });
    }
    persisted = true;
    return NextResponse.json({
      website: await buildWebsiteApiView(updated),
      imageGeneration: usage,
    }, { status: 201, headers: headers(req) });
  } catch (error) {
    const authenticatedUserId = userId;
    if (reservationId) {
      try {
        if (!authenticatedUserId) throw new Error('The quota reservation has no authenticated owner.');
        await releaseWebsiteImageGenerationReservation(authenticatedUserId, reservationId);
      } catch (releaseError) {
        logger.error('Website image-generation quota reservation cleanup failed', {
          errorName: releaseError instanceof Error ? releaseError.name : 'UnknownError',
        });
      }
    }
    if (!persisted && (uploadedObjectKey || uploadedR2ObjectKey)) {
      const cleanup = await Promise.allSettled([
        uploadedObjectKey ? deletePrivateWebsiteUpload(uploadedObjectKey) : Promise.resolve(),
        uploadedR2ObjectKey ? deletePrivateWebsiteAssetFromR2(uploadedR2ObjectKey) : Promise.resolve(),
      ]);
      if (cleanup.some((result) => result.status === 'rejected')) {
        logger.error('Generated website image cleanup failed', { failedCleanupCount: cleanup.filter((result) => result.status === 'rejected').length });
      }
    }
    if (error instanceof RequestBodyError) return errorResponse(req, error.message, error.status, error.code);
    if (error instanceof AIRequestGatewayError) return NextResponse.json(error.body, { status: error.status, headers: { ...error.headers, ...headers(req) } });
    if (error instanceof WebsiteAccessError) return errorResponse(req, error.message, error.status, 'website_pro_required');
    if (error instanceof WebsiteImageGenerationQuotaError) {
      return errorResponse(req, error.message, 429, 'website_image_generation_limit_reached', { imageGeneration: error.usage });
    }
    if (error instanceof WebsiteImageGenerationError) {
      const unavailable = error.message.includes('not configured');
      return errorResponse(req, unavailable ? error.message : 'The image model could not generate an image. Your monthly allowance was not used.', unavailable ? 503 : 502, unavailable ? 'image_generation_not_configured' : 'image_generation_failed');
    }
    logger.error('Website image generation failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return errorResponse(req, 'The image could not be generated or saved. Please try again.', 500, 'website_image_generation_failed');
  }
}

export const runtime = 'nodejs';
