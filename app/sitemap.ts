import type { MetadataRoute } from 'next';

const canonicalOrigin = process.env.AUTH_WEB_BASE_URL || 'https://app.mento.ai';

const publicRoutes = [
  '/',
  '/legal/privacy',
  '/legal/terms',
  '/legal/ai',
  '/legal/account-deletion',
];

export default function sitemap(): MetadataRoute.Sitemap {
  return publicRoutes.map((path) => ({
    url: new URL(path, canonicalOrigin).toString(),
    changeFrequency: path === '/' ? 'weekly' : 'yearly',
    priority: path === '/' ? 1 : 0.6,
  }));
}
