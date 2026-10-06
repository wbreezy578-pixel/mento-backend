import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { AIRequestGatewayError, authenticateAIRequest, enforceAIGatewayRateLimit, getClientIp } from '../../../../../../lib/aiSecurityGateway';
import { buildCorsHeaders } from '../../../../../../lib/securityHeaders';
import { prisma } from '../../../../../../lib/prisma';
import { detectImageMimeType, validateImageBuffer } from '../../../../../../lib/imageValidator';
import { buildWebsiteApiView } from '../../../../../../services/websiteAssetApi';
import { deletePrivateWebsiteUpload, isAllowedWebsiteImageUploadMimeType, savePrivateWebsiteUpload } from '../../../../../../services/websiteAssetService';
import { normalizeWebsiteContent, type WebsiteContent } from '../../../../../../services/websiteContent';
import { assertWebsiteFeatureAccess, WebsiteAccessError } from '../../../../../../services/websiteBillingService';

type RouteContext = { params: Promise<{ websiteId: string }> };
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + 64 * 1024;

function headers(req: Request) {
  return { ...buildCorsHeaders(req.headers.get('origin')), 'Cache-Control': 'no-store, private' };
}

function errorResponse(req: Request, message: string, status: number, code: string) {
  return NextResponse.json({ error: message, code }, { status, headers: headers(req) });
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': 'POST, OPTIONS' } });
}

export async function POST(req: Request, context: RouteContext) {
  let uploadedObjectKey: string | null = null;
  let persisted = false;
  try {
    const user = await authenticateAIRequest(req);
    await enforceAIGatewayRateLimit(user.id, getClientIp(req));
    const { websiteId } = await context.params;
    const contentLength = Number(req.headers.get('content-length'));
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0) return errorResponse(req, 'Content-Length is required for image uploads.', 411, 'content_length_required');
    if (contentLength > MAX_REQUEST_BYTES) return errorResponse(req, 'Choose an image smaller than 8 MB.', 413, 'image_too_large');
    if (!(req.headers.get('content-type') ?? '').toLowerCase().includes('multipart/form-data')) return errorResponse(req, 'Upload an image using multipart form data.', 415, 'unsupported_upload_format');

    const website = await prisma.website.findFirst({ where: { id: websiteId, userId: user.id } });
    if (!website) return errorResponse(req, 'Website not found.', 404, 'website_not_found');
    await assertWebsiteFeatureAccess(user.id, 'edit');
    const currentContent = normalizeWebsiteContent(website.content);
    if (!currentContent) return errorResponse(req, 'This website draft needs repair before it can accept images.', 409, 'invalid_website_content');

    const form = await req.formData();
    const slotId = typeof form.get('slotId') === 'string' ? String(form.get('slotId')) : '';
    const revision = Number(form.get('revision'));
    const slot = currentContent.imageSlots.find((imageSlot) => imageSlot.id === slotId);
    if (!slot) return errorResponse(req, 'Image slot not found.', 404, 'image_slot_not_found');
    if (revision !== website.revision) return errorResponse(req, 'This website changed elsewhere. Reload it before uploading.', 409, 'website_revision_conflict');

    const uploaded = form.get('image');
    if (!uploaded || typeof uploaded === 'string' || typeof (uploaded as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer !== 'function') {
      return errorResponse(req, 'Choose an image to upload.', 400, 'image_required');
    }
    const file = uploaded as { arrayBuffer: () => Promise<ArrayBuffer>; type?: string; size?: number };
    if (typeof file.size === 'number' && file.size > MAX_UPLOAD_BYTES) return errorResponse(req, 'Choose an image smaller than 8 MB.', 413, 'image_too_large');
    const sourceBuffer = Buffer.from(await file.arrayBuffer());
    const declaredMimeType = file.type || detectImageMimeType(sourceBuffer) || '';
    if (!isAllowedWebsiteImageUploadMimeType(declaredMimeType)) return errorResponse(req, 'Choose a JPEG, PNG, WebP, or HEIC image.', 415, 'unsupported_image_type');
    try {
      validateImageBuffer(sourceBuffer, declaredMimeType);
    } catch {
      return errorResponse(req, 'The uploaded file is not a valid supported image.', 400, 'invalid_image');
    }

    const stored = await savePrivateWebsiteUpload({ userId: user.id, websiteId, buffer: sourceBuffer, mimeType: declaredMimeType });
    uploadedObjectKey = stored.objectKey;
    const assetId = randomUUID();
    const nextContent: WebsiteContent = {
      ...currentContent,
      imageSlots: currentContent.imageSlots.map((imageSlot) => imageSlot.id === slotId ? { ...imageSlot, assetId } : imageSlot),
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
          slotId,
          source: 'user_upload',
          providerAssetId: null,
          objectKey: stored.objectKey,
          remoteUrl: null,
          sourcePageUrl: null,
          creatorName: null,
          creatorProfileUrl: null,
          alt: slot.alt,
          mimeType: stored.mimeType,
          width: stored.width,
          height: stored.height,
        },
      });
      return tx.website.findFirst({ where: { id: websiteId, userId: user.id } });
    });
    if (!updated) {
      await deletePrivateWebsiteUpload(uploadedObjectKey);
      uploadedObjectKey = null;
      return errorResponse(req, 'This website changed elsewhere. Reload it before uploading.', 409, 'website_revision_conflict');
    }
    persisted = true;

    return NextResponse.json({ website: await buildWebsiteApiView(updated) }, { status: 201, headers: headers(req) });
  } catch (error) {
    if (uploadedObjectKey && !persisted) await deletePrivateWebsiteUpload(uploadedObjectKey).catch(() => undefined);
    if (error instanceof WebsiteAccessError) return errorResponse(req, error.message, error.status, 'website_pro_required');
    if (error instanceof AIRequestGatewayError) return NextResponse.json(error.body, { status: error.status, headers: { ...error.headers, ...headers(req) } });
    const message = error instanceof Error ? error.message : 'Image upload is unavailable.';
    const storageNotConfigured = message.includes('storage is not configured');
    return errorResponse(req, storageNotConfigured ? 'Website image storage is not configured on the server.' : 'The image could not be saved. Please try again.', storageNotConfigured ? 503 : 500, storageNotConfigured ? 'asset_storage_unavailable' : 'asset_upload_failed');
  }
}

export const runtime = 'nodejs';