import { randomUUID } from 'node:crypto';
import { Storage } from '@google-cloud/storage';
import sharp from 'sharp';
import { validateImageBuffer } from '../lib/imageValidator';
import type { WebsiteContent, WebsiteImageSlot } from './websiteContent';
import { searchPexelsImages, type PexelsImageCandidate } from './pexelsService';

const MAX_AUTOMATIC_PEXELS_SLOTS = 3;
const USER_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const SIGNED_PREVIEW_TTL_MS = 30 * 60 * 1000;
let storageClient: Storage | null = null;

export interface WebsiteAssetCreateData {
  id: string;
  slotId: string;
  source: 'pexels' | 'user_upload';
  providerAssetId: string | null;
  objectKey: string | null;
  remoteUrl: string | null;
  sourcePageUrl: string | null;
  creatorName: string | null;
  creatorProfileUrl: string | null;
  alt: string;
  mimeType: string | null;
  width: number | null;
  height: number | null;
}

function createPexelsAsset(slot: WebsiteImageSlot, photo: PexelsImageCandidate): WebsiteAssetCreateData {
  return {
    id: randomUUID(),
    slotId: slot.id,
    source: 'pexels',
    providerAssetId: photo.providerAssetId,
    objectKey: null,
    remoteUrl: photo.imageUrl,
    sourcePageUrl: photo.sourcePageUrl,
    creatorName: photo.creatorName,
    creatorProfileUrl: photo.creatorProfileUrl,
    alt: photo.alt || slot.alt,
    mimeType: null,
    width: photo.width,
    height: photo.height,
  };
}

export async function fillWebsiteImageSlots(content: WebsiteContent): Promise<{ content: WebsiteContent; assets: WebsiteAssetCreateData[] }> {
  const assets: WebsiteAssetCreateData[] = [];
  const selectedProviderIds = new Set<string>();
  const nextSlots = [...content.imageSlots];
  const missing = nextSlots.filter((slot) => !slot.assetId).slice(0, MAX_AUTOMATIC_PEXELS_SLOTS);

  for (const slot of missing) {
    try {
      const orientation = slot.role === 'menu_item' ? 'square' : 'landscape';
      const results = await searchPexelsImages(slot.query, orientation);
      const photo = results.find((candidate) => !selectedProviderIds.has(candidate.providerAssetId));
      if (!photo) continue;
      selectedProviderIds.add(photo.providerAssetId);
      const asset = createPexelsAsset(slot, photo);
      assets.push(asset);
      const index = nextSlots.findIndex((candidate) => candidate.id === slot.id);
      if (index >= 0) nextSlots[index] = { ...nextSlots[index], assetId: asset.id };
    } catch {
      // Image search is an enhancement; website generation remains usable when Pexels is unavailable.
    }
  }

  return { content: { ...content, imageSlots: nextSlots }, assets };
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
}): Promise<{ objectKey: string; mimeType: string; width: number; height: number; previewUrl: string }> {
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
  if (asset.source === 'pexels') return asset.remoteUrl;
  if (asset.source !== 'user_upload' || !asset.objectKey) return null;
  const [url] = await getStorage().bucket(getBucketName()).file(asset.objectKey).getSignedUrl({
    action: 'read',
    expires: Date.now() + SIGNED_PREVIEW_TTL_MS,
  });
  return url;
}

export async function deletePrivateWebsiteUpload(objectKey: string | null): Promise<void> {
  if (!objectKey || !process.env.WEBSITE_ASSETS_BUCKET?.trim()) return;
  await getStorage().bucket(getBucketName()).file(objectKey).delete({ ignoreNotFound: true });
}

export function isAllowedWebsiteImageUploadMimeType(mimeType: string): boolean {
  return mimeType === 'image/jpeg' || mimeType === 'image/png' || mimeType === 'image/webp' || mimeType === 'image/heic' || mimeType === 'image/heif';
}