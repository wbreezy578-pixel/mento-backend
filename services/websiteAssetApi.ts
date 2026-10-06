import type { Website, WebsiteAsset } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { getWebsiteAssetPreviewUrl } from './websiteAssetService';
import { normalizeWebsiteContent } from './websiteContent';

export type WebsiteAssetView = Omit<WebsiteAsset, 'objectKey'> & { previewUrl: string | null };

export async function getWebsiteAssetViews(websiteId: string, rawContent: unknown): Promise<WebsiteAssetView[]> {
  const content = normalizeWebsiteContent(rawContent);
  const assetIds = [...new Set(content?.imageSlots.map((slot) => slot.assetId).filter((id): id is string => id !== null) ?? [])];
  if (!assetIds.length) return [];
  const assets = await prisma.websiteAsset.findMany({ where: { websiteId, id: { in: assetIds } } });
  return Promise.all(assets.map(async (asset) => {
    const { objectKey, ...publicAsset } = asset;
    return {
      ...publicAsset,
      previewUrl: await getWebsiteAssetPreviewUrl({ source: asset.source, remoteUrl: asset.remoteUrl, objectKey }),
    };
  }));
}

export async function buildWebsiteApiView<T extends Pick<Website, 'id' | 'content'>>(website: T) {
  const assets = await getWebsiteAssetViews(website.id, website.content);
  return { ...website, assets };
}