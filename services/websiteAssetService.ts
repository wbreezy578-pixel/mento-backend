import { randomUUID } from 'node:crypto';
import { Storage } from '@google-cloud/storage';
import sharp from 'sharp';
import { validateImageBuffer } from '../lib/imageValidator';

const USER_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const SIGNED_PREVIEW_TTL_MS = 30 * 60 * 1000;
let storageClient: Storage | null = null;

export interface WebsiteAssetCreateData {
  id: string;
  slotId: string;
  source: 'pexels' | 'pixabay' | 'unsplash' | 'user_upload' | 'imagen_generated' | 'gemini_generated';
  providerAssetId: string | null;
  objectKey: string | null;
  r2ObjectKey?: string | null;
  remoteUrl: string | null;
  providerImageUrl?: string | null;
  providerTags?: string[];
  searchQuery?: string | null;
  retrievedAt?: Date | null;
  licenseName?: string | null;
  licenseUrl?: string | null;
  attributionRequired?: boolean;
  version?: number;
  sourcePageUrl: string | null;
  creatorName: string | null;
  creatorProfileUrl: string | null;
  alt: string;
  mimeType: string | null;
  width: number | null;
  height: number | null;
}

function getStorage(): Storage {
  if (!process.env.WEBSITE_ASSETS_BUCKET?.trim()) throw new Error('Website image storage is not configured.');
  storageClient ??= new Storage();
  return storageClient;
}

function getBucketName(): string {
  const bucketName = process.env.WEBSITE_ASSETS_BUCKET?.trim();
  if (!bucketName) throw new Error('Website image storage is not configured.');
  return bucketName;
}

function getImageExtension(mimeType: string): string {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
}

export async function savePrivateWebsiteUpload(input: {
  userId: string;
  websiteId: string;
  buffer: Buffer;
  mimeType: string;
}): Promise<{ objectKey: string; mimeType: string; width: number; height: number; previewUrl: string; buffer: Buffer }> {
  if (input.buffer.length > USER_IMAGE_MAX_BYTES) throw new Error('Website images must be 8 MB or smaller.');
  const validated = validateImageBuffer(input.buffer, input.mimeType);
  const output = await sharp(validated.buffer, { limitInputPixels: 25_000_000 })
    .rotate()
    .resize({ width: 2200, height: 2200, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 84, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  if (output.data.length > USER_IMAGE_MAX_BYTES) throw new Error('Optimized image is still too large. Choose a smaller photo.');

  const objectKey = `website-assets/${input.userId}/${input.websiteId}/${randomUUID()}.${getImageExtension('image/jpeg')}`;
  const file = getStorage().bucket(getBucketName()).file(objectKey);
  try {
    await file.save(output.data, {
      resumable: false,
      metadata: {
        contentType: 'image/jpeg',
        cacheControl: 'private, no-store, max-age=0',
        metadata: { websiteId: input.websiteId, userId: input.userId },
      },
    });
    const [previewUrl] = await file.getSignedUrl({ action: 'read', expires: Date.now() + SIGNED_PREVIEW_TTL_MS });
    return {
      objectKey,
      mimeType: 'image/jpeg',
      width: output.info.width,
      height: output.info.height,
      buffer: output.data,
      previewUrl,
    };
  } catch (error) {
    await file.delete({ ignoreNotFound: true }).catch(() => undefined);
    throw error;
  }
}

export async function getWebsiteAssetPreviewUrl(asset: {
  source: string;
  remoteUrl: string | null;
  objectKey: string | null;
}): Promise<string | null> {
  if (asset.source === 'pexels' || asset.source === 'unsplash') return asset.remoteUrl;
  if (!['pixabay', 'user_upload', 'imagen_generated', 'gemini_generated'].includes(asset.source) || !asset.objectKey) return null;
  const [url] = await getStorage().bucket(getBucketName()).file(asset.objectKey).getSignedUrl({
    action: 'read',
    expires: Date.now() + SIGNED_PREVIEW_TTL_MS,
  });
  return url;
}

export async function readPrivateWebsiteUpload(objectKey: string): Promise<Buffer> {
  const [buffer] = await getStorage().bucket(getBucketName()).file(objectKey).download();
  if (buffer.length === 0 || buffer.length > USER_IMAGE_MAX_BYTES) {
    throw new Error('A saved website image is empty or exceeds the publishing limit.');
  }
  return buffer;
}

export async function deletePrivateWebsiteUpload(objectKey: string | null): Promise<void> {
  if (!objectKey || !process.env.WEBSITE_ASSETS_BUCKET?.trim()) return;
  await getStorage().bucket(getBucketName()).file(objectKey).delete({ ignoreNotFound: true });
}

export function isAllowedWebsiteImageUploadMimeType(mimeType: string): boolean {
  return mimeType === 'image/jpeg' || mimeType === 'image/png' || mimeType === 'image/webp' || mimeType === 'image/heic' || mimeType === 'image/heif';
}