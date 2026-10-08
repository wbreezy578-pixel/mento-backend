import { prisma } from '../lib/prisma';
import { getWebsiteHostingState } from './websiteBillingService';
import { isWebsiteHostname } from './websiteDeploymentStorage';

const PUBLIC_API_ORIGIN = 'https://api.trymentoapp.com';

export type PublishedWebsiteQrTarget = {
  id: string;
  title: string;
  type: string;
  hostname: string;
  destinationUrl: string;
  qrUrl: string;
};

export function buildStableWebsiteQrUrl(websiteId: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(websiteId)) {
    throw new Error('Website ID cannot be used in a QR URL.');
  }
  return new URL(`/api/websites/qr/${encodeURIComponent(websiteId)}`, PUBLIC_API_ORIGIN).toString();
}

export async function getPublishedWebsiteQrTarget(websiteId: string): Promise<PublishedWebsiteQrTarget | null> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(websiteId)) return null;
  const website = await prisma.website.findFirst({
    where: {
      id: websiteId,
      status: 'published',
      deletedAt: null,
      publishedVersion: { not: null },
      publishedDeploymentId: { not: null },
    },
    select: {
      id: true,
      title: true,
      type: true,
      domains: {
        where: { kind: 'mento_subdomain', status: 'active' },
        select: { hostname: true },
        take: 1,
      },
    },
  });
  const hostname = website?.domains[0]?.hostname;
  if (!website || !hostname || !isWebsiteHostname(hostname)) return null;
  const hosting = await getWebsiteHostingState(website.id);
  if (hosting.status === 'suspended') return null;
  return {
    id: website.id,
    title: website.title,
    type: website.type,
    hostname,
    destinationUrl: `https://${hostname}/`,
    qrUrl: buildStableWebsiteQrUrl(website.id),
  };
}
