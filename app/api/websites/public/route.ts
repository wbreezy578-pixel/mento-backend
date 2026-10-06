import { NextResponse } from 'next/server';
import { prisma } from '../../../../lib/prisma';
import logger from '../../../../lib/logger';
import { buildWebsitePublicHtml, normalizeHostname } from '../../../../services/websiteDeploymentService';
import { getWebsiteHostingState } from '../../../../services/websiteBillingService';

const WEBSITE_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?\.mento\.site$/;

function unavailable(status = 404) {
  return new NextResponse('<!doctype html><html><body><h1>Website unavailable</h1></body></html>', {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, private' },
  });
}

export async function GET(req: Request) {
  try {
    const normalizedHost = normalizeHostname(req.headers.get('host') ?? '');
    if (!normalizedHost || !WEBSITE_HOST_PATTERN.test(normalizedHost)) return unavailable();

    const deployments = await prisma.websiteDeployment.findMany({
      where: {
        hostname: normalizedHost,
        status: 'published',
        website: { is: { status: 'published', deletedAt: null } },
      },
      include: {
        website: {
          select: { id: true, title: true, status: true, deletedAt: true, publishedVersion: true, publishedDeploymentId: true },
        },
      },
    });
    const selectedDeployments = deployments.filter((candidate) => (
      candidate.website
      && candidate.website.status === 'published'
      && candidate.website.deletedAt === null
      && candidate.website.publishedDeploymentId === candidate.id
      && candidate.website.publishedVersion === candidate.version
    ));
    if (selectedDeployments.length !== 1) return unavailable();
    const deployment = selectedDeployments[0];
    if (!deployment.website) return unavailable();

    const version = await prisma.websiteVersion.findFirst({
      where: { websiteId: deployment.website.id, version: deployment.version },
      select: { content: true },
    });
    if (!version) return unavailable();

    const hostingStatus = await getWebsiteHostingState(deployment.website.id);
    if (hostingStatus.status === 'suspended') {
      return unavailable();
    }

    const html = buildWebsitePublicHtml({ title: deployment.website.title, content: version.content });
    return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, private' } });
  } catch (error) {
    logger.error('Public website could not be served', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return unavailable(500);
  }
}

export const runtime = 'nodejs';
