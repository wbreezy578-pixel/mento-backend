import type { MetadataRoute } from 'next';

const publicRoutes = [
  '/',
  '/legal/privacy',
  '/legal/terms',
  '/legal/ai',
  '/legal/account-deletion',
];

export default function sitemap(): MetadataRoute.Sitemap {
  return publicRoutes.map((path) => ({
    url: path,
    lastModified: new Date(),
    changeFrequency: path === '/' ? 'weekly' : 'yearly',
    priority: path === '/' ? 1 : 0.6,
  }));
}