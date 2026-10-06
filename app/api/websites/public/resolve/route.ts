import { NextResponse } from 'next/server';
import { prisma } from '../../../../../lib/prisma';
import { verifyWebsiteRouterRequest } from '../../../../../lib/websiteRouterAuth';
import logger from '../../../../../lib/logger';
import { getWebsiteHostingState } from '../../../../../services/websiteBillingService';
import { isWebsiteHostname } from '../../../../../services/websiteDeploymentStorage';

export const runtime = 'nodejs';

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store, private',
      'Vary': 'x-mento-signature',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function GET(request: Request) {
  const secret = process.env.WEBSITE_ROUTER_SHARED_SECRET?.trim();
  if (!secret) return json({ error: 'Website routing is not configured.' }, 503);

  let authenticated = false;
  try {
    authenticated = await verifyWebsiteRouterRequest(request, secret);
  } catch (error) {
    logger.error('Website router authentication could not be checked', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return json({ error: 'Website routing is temporarily unavailable.' }, 503);
  }
  if (!authenticated) return json({ error: 'Unauthorized.' }, 401);

  const hostname = new URL(request.url).searchParams.get('hostname')?.trim().toLowerCase() ?? '';
  if (!isWebsiteHostname(hostname)) return json({ error: 'Website unavailable.' }, 404);

  try {
    const domain = await prisma.websiteDomain.findUnique({
      where: { hostname },
      select: {
        status: true,
        website: {
          select: {
            id: true,
            status: true,
            deletedAt: true,
            publishedVersion: true,
            publishedDeploymentId: true,
          },
        },
      },
    });
    if (
      !domain
      || domain.status !== 'active'
      || domain.website.status !== 'published'
      || domain.website.deletedAt !== null
      || !domain.website.publishedDeploymentId
      || !domain.website.publishedVersion
    ) {
      return json({ error: 'Website unavailable.' }, 404);
    }

    const [deployment, hosting] = await Promise.all([
      prisma.websiteDeployment.findFirst({
        where: {
          id: domain.website.publishedDeploymentId,
          websiteId: domain.website.id,
          version: domain.website.publishedVersion,
          status: 'published',
        },
        select: { id: true, websiteId: true, r2Prefix: true, manifestKey: true },
      }),
      getWebsiteHostingState(domain.website.id),
    ]);
    if (hosting.status === 'suspended' || !deployment?.r2Prefix || !deployment.manifestKey) {
      return json({ error: 'Website unavailable.' }, 404);
    }

    return json({
      websiteId: deployment.websiteId,
      deploymentId: deployment.id,
      manifestKey: deployment.manifestKey,
    }, 200);
  } catch (error) {
    logger.error('Website hostname could not be resolved', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return json({ error: 'Website routing is temporarily unavailable.' }, 503);
  }
}
