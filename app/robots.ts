import type { MetadataRoute } from 'next';

const canonicalOrigin = process.env.AUTH_WEB_BASE_URL || 'https://app.mento.ai';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/api/', '/auth/', '/billing/'],
    },
    sitemap: new URL('/sitemap.xml', canonicalOrigin).toString(),
  };
}
