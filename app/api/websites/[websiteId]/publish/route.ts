import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../../../lib/prisma';
import logger from '../../../../../lib/logger';
import { AIRequestGatewayError, authenticateAIRequest, enforceAIGatewayRateLimit, getClientIp } from '../../../../../lib/aiSecurityGateway';
import { readJsonBodyWithLimit, RequestBodyError } from '../../../../../lib/requestBody';
import { buildCorsHeaders } from '../../../../../lib/securityHeaders';
import { isWebsiteSlugUniqueConstraintError, slugifyWebsiteName } from '../../../../../services/websiteDeploymentService';
import { ensureWebsiteWorkerDomain, WebsiteHostnameProvisioningError } from '../../../../../services/websiteCloudflareDomainService';
import {
  createWebsiteHostname,
  deleteWebsiteDeploymentArtifacts,
  uploadWebsiteDeployment,
  WebsiteDeploymentConfigurationError,
  type UploadedWebsiteDeployment,
} from '../../../../../services/websiteDeploymentStorage';
import {
  getScheduledWebsiteHostingLimit,
  getWebsiteHostingEntitlement,
  type WebsiteHostingAccountSnapshot,
} from '../../../../../services/websiteBillingService';

const MAX_BODY_BYTES = 8 * 1024;
type RouteContext = { params: Promise<{ websiteId: string }> };

class WebsiteHostnameConflictError extends Error {}

function headers(req: Request) {
  return { ...buildCorsHeaders(req.headers.get('origin')), 'Cache-Control': 'no-store, private' };
}

export async function POST(req: Request, context: RouteContext) {
  let stagedArtifact: UploadedWebsiteDeployment | null = null;
  try {
    const user = await authenticateAIRequest(req);
    await enforceAIGatewayRateLimit(user.id, getClientIp(req));
    const { websiteId } = await context.params;

    let body: { version?: unknown; revision?: unknown };
    try {
      body = await readJsonBodyWithLimit(req, MAX_BODY_BYTES);
    } catch (error) {
      const bodyError = error instanceof RequestBodyError ? error : new RequestBodyError('Invalid JSON body.', 400, 'invalid_json');
      return NextResponse.json({ error: bodyError.message, code: bodyError.code }, { status: bodyError.status, headers: headers(req) });
    }

    const website = await prisma.website.findFirst({
      where: { id: websiteId, userId: user.id, deletedAt: null },
      select: { id: true, userId: true, revision: true, currentVersion: true, publishedVersion: true, status: true, title: true },
    });
    if (!website) return NextResponse.json({ error: 'Website not found.' }, { status: 404, headers: headers(req) });

    if (body.revision !== undefined && (!Number.isSafeInteger(body.revision) || (body.revision as number) !== website.revision)) {
      return NextResponse.json({ error: 'This website changed elsewhere. Reload it before publishing.', code: 'website_revision_conflict' }, { status: 409, headers: headers(req) });
    }

    const requestedVersion = Number.isSafeInteger(body.version) ? Number(body.version) : website.currentVersion;
    if (requestedVersion < 1 || requestedVersion > website.currentVersion) {
      return NextResponse.json({ error: 'Choose a valid website version to publish.', code: 'invalid_website_version' }, { status: 400, headers: headers(req) });
    }

    const slug = slugifyWebsiteName(website.title);
    if (!slug) {
      return NextResponse.json({ error: 'Choose a website name that can be used in a website address.', code: 'invalid_website_slug' }, { status: 400, headers: headers(req) });
    }
    const hostname = createWebsiteHostname(slug);
    const conflictingWebsite = await prisma.website.findFirst({
      where: { slug, id: { not: websiteId } },
      select: { id: true },
    });
    if (conflictingWebsite) {
      return NextResponse.json({ error: 'That website address is already in use. Choose a different website name.', code: 'website_slug_conflict' }, { status: 409, headers: headers(req) });
    }

    const version = await prisma.websiteVersion.findFirst({
      where: { websiteId, version: requestedVersion },
      select: { content: true },
    });
    if (!version) {
      return NextResponse.json({ error: 'The selected website version could not be found.', code: 'website_version_not_found' }, { status: 404, headers: headers(req) });
    }
    stagedArtifact = await uploadWebsiteDeployment({
      websiteId,
      version: requestedVersion,
      content: version.content,
    });

    const published = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "WebsiteHostingAccount" WHERE "userId" = ${user.id} FOR UPDATE`;
      const account = await tx.websiteHostingAccount.findUnique({ where: { userId: user.id } }) as WebsiteHostingAccountSnapshot & {
        id: string;
        userId: string;
        providerPurchaseTokenHash: string | null;
      } | null;
      const now = new Date();
      const entitlement = getWebsiteHostingEntitlement(account, now);
      if (entitlement.status === 'suspended') return { kind: 'hosting_inactive' as const };

      let siteLimit = entitlement.siteLimit;
      const scheduleDue = account?.scheduledEffectiveAt && account.scheduledEffectiveAt.getTime() <= now.getTime();
      if (account && scheduleDue) {
        const scheduledLimit = getScheduledWebsiteHostingLimit(account, now) ?? 0;
        const websites = await tx.website.findMany({
          where: { userId: user.id, deletedAt: null, status: 'published' },
          select: {
            id: true,
            publishedDeploymentId: true,
            deployments: {
              where: { status: 'published' },
              orderBy: { publishedAt: 'asc' },
              select: { id: true, publishedAt: true },
            },
          },
        });
        const selectedIds = Array.isArray(account.scheduledKeptWebsiteIds)
          ? account.scheduledKeptWebsiteIds.filter((id): id is string => typeof id === 'string')
          : [];
        const ordered = websites
          .map((site) => ({
            id: site.id,
            publishedAt: site.deployments.find((deployment) => deployment.id === site.publishedDeploymentId)?.publishedAt
              ?? site.deployments[0]?.publishedAt
              ?? new Date(0),
          }))
          .sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());
        const keep = selectedIds
          .map((id) => ordered.find((site) => site.id === id))
          .filter((site): site is (typeof ordered)[number] => Boolean(site))
          .slice(0, scheduledLimit);
        const keepIds = new Set(keep.map((site) => site.id));
        for (const site of ordered) {
          if (keepIds.size >= scheduledLimit) break;
          keepIds.add(site.id);
        }
        const pauseIds = ordered.filter((site) => !keepIds.has(site.id)).map((site) => site.id);
        if (pauseIds.length > 0) {
          await tx.website.updateMany({
            where: { id: { in: pauseIds }, userId: user.id, status: 'published' },
            data: { status: 'draft', publishedVersion: null, publishedDeploymentId: null, updatedAt: now },
          });
          await tx.websiteDeployment.updateMany({
            where: { websiteId: { in: pauseIds }, status: 'published' },
            data: { status: 'paused', unpublishedAt: now },
          });
          await tx.websiteDomain.updateMany({
            where: { websiteId: { in: pauseIds }, status: 'active' },
            data: { status: 'disabled' },
          });
          if (selectedIds.length === 0) {
            await tx.notification.create({
              data: {
                userId: user.id,
                title: 'Website hosting tier updated',
                body: `${pauseIds.length} recently published website${pauseIds.length === 1 ? ' was' : 's were'} paused to fit your new hosting capacity.`,
                type: 'billing',
                category: 'BILLING',
                actionUrl: '/websites',
                externalId: `website-hosting-downgrade:${account.id}:${account.scheduledEffectiveAt?.toISOString()}`,
                metadata: { pausedWebsiteIds: pauseIds, siteLimit: scheduledLimit },
              },
            });
          }
        }
        await tx.websiteHostingAccount.update({
          where: { userId: user.id },
          data: {
            tier: account.scheduledTier,
            siteLimit: scheduledLimit,
            scheduledTier: null,
            scheduledSiteLimit: null,
            scheduledEffectiveAt: null,
            scheduledKeptWebsiteIds: Prisma.DbNull,
          },
        });
        siteLimit = scheduledLimit;
      }

      if (siteLimit > 0) {
        const currentPublishedCount = await tx.website.count({
          where: { userId: user.id, deletedAt: null, status: 'published' },
        });
        if (currentPublishedCount > siteLimit && account) {
          const websites = await tx.website.findMany({
            where: { userId: user.id, deletedAt: null, status: 'published' },
            select: {
              id: true,
              publishedDeploymentId: true,
              deployments: {
                where: { status: 'published' },
                orderBy: { publishedAt: 'asc' },
                select: { id: true, publishedAt: true },
              },
            },
          });
          const ordered = websites
            .map((site) => ({
              id: site.id,
              publishedAt: site.deployments.find((deployment) => deployment.id === site.publishedDeploymentId)?.publishedAt
                ?? site.deployments[0]?.publishedAt
                ?? new Date(0),
            }))
            .sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());
          const pauseIds = ordered.slice(siteLimit).map((site) => site.id);
          if (pauseIds.length > 0) {
            await tx.website.updateMany({
              where: { id: { in: pauseIds }, userId: user.id, status: 'published' },
              data: { status: 'draft', publishedVersion: null, publishedDeploymentId: null, updatedAt: now },
            });
            await tx.websiteDeployment.updateMany({
              where: { websiteId: { in: pauseIds }, status: 'published' },
              data: { status: 'paused', unpublishedAt: now },
            });
            await tx.websiteDomain.updateMany({
              where: { websiteId: { in: pauseIds }, status: 'active' },
              data: { status: 'disabled' },
            });
            await tx.notification.create({
              data: {
                userId: user.id,
                title: 'Website hosting capacity updated',
                body: `${pauseIds.length} recently published website${pauseIds.length === 1 ? ' was' : 's were'} paused to fit your verified hosting capacity.`,
                type: 'billing',
                category: 'BILLING',
                actionUrl: '/websites',
                externalId: `website-hosting-capacity:${account.id}:${siteLimit}:${now.toISOString()}`,
                metadata: { pausedWebsiteIds: pauseIds, siteLimit },
              },
            });
          }
        }
      }

      if (siteLimit < 1) return { kind: 'hosting_inactive' as const };
      const [publishedCount, alreadyPublished] = await Promise.all([
        tx.website.count({ where: { userId: user.id, deletedAt: null, status: 'published' } }),
        tx.website.findFirst({
          where: { id: websiteId, userId: user.id, deletedAt: null, status: 'published' },
          select: { id: true },
        }),
      ]);
      if (!alreadyPublished && publishedCount >= siteLimit) return { kind: 'capacity_reached' as const, siteLimit };

      const existingDomain = await tx.websiteDomain.findFirst({
        where: { websiteId, kind: 'mento_subdomain' },
        select: { id: true, hostname: true },
      });
      const hostnameOwner = await tx.websiteDomain.findUnique({
        where: { hostname },
        select: { id: true, websiteId: true },
      });
      if (hostnameOwner && hostnameOwner.websiteId !== websiteId) throw new WebsiteHostnameConflictError();
      await ensureWebsiteWorkerDomain(hostname);
      let domain: { hostname: string };
      if (existingDomain) {
        domain = await tx.websiteDomain.update({
          where: { id: existingDomain.id },
          data: { hostname, status: 'active', verifiedAt: now },
          select: { hostname: true },
        });
      } else {
        domain = await tx.websiteDomain.create({
          data: { hostname, websiteId, kind: 'mento_subdomain', status: 'active', verifiedAt: now },
          select: { hostname: true },
        });
      }

      const deployment = await tx.websiteDeployment.create({
        data: {
          id: stagedArtifact!.deploymentId,
          websiteId,
          version: requestedVersion,
          status: 'published',
          hostname,
          storagePath: stagedArtifact!.r2Prefix,
          r2Prefix: stagedArtifact!.r2Prefix,
          manifestKey: stagedArtifact!.manifestKey,
          artifactHash: stagedArtifact!.artifactHash,
          artifactSize: stagedArtifact!.artifactSize,
          publishedAt: now,
        },
      });
      await tx.websiteDeployment.updateMany({
        where: { websiteId, id: { not: deployment.id }, status: 'published' },
        data: { status: 'superseded', unpublishedAt: now },
      });
      const updated = await tx.website.update({
        where: { id: websiteId, userId: user.id },
        data: {
          slug,
          status: 'published',
          publishedVersion: requestedVersion,
          publishedDeploymentId: deployment.id,
          updatedAt: now,
        },
      });
      return { kind: 'published' as const, website: updated, deployment, hostname: domain.hostname };
    }, { maxWait: 10_000, timeout: 30_000 });

    if (published.kind === 'hosting_inactive') {
      await deleteWebsiteDeploymentArtifacts(stagedArtifact);
      stagedArtifact = null;
      return NextResponse.json({
        error: 'An active website hosting subscription is required to publish. Your existing hosting remains available through its verified paid-through or grace period.',
        code: 'website_hosting_required',
      }, { status: 403, headers: headers(req) });
    }
    if (published.kind === 'capacity_reached') {
      await deleteWebsiteDeploymentArtifacts(stagedArtifact);
      stagedArtifact = null;
      return NextResponse.json({
        error: `Your hosting plan allows ${published.siteLimit} live website${published.siteLimit === 1 ? '' : 's'}. Unpublish a website or change your hosting tier to publish this one.`,
        code: 'website_hosting_capacity_reached',
      }, { status: 409, headers: headers(req) });
    }
    stagedArtifact = null;
    return NextResponse.json({ website: published.website, deployment: published.deployment, hostname: published.hostname }, { headers: headers(req) });
  } catch (error) {
    if (stagedArtifact) {
      try {
        await deleteWebsiteDeploymentArtifacts(stagedArtifact);
      } catch (cleanupError) {
        logger.error('Uncommitted website deployment artifacts could not be removed', {
          errorName: cleanupError instanceof Error ? cleanupError.name : 'UnknownError',
        });
      }
    }
    if (error instanceof RequestBodyError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: headers(req) });
    if (error instanceof AIRequestGatewayError) return NextResponse.json(error.body, { status: error.status, headers: { ...error.headers, ...headers(req) } });
    if (error instanceof WebsiteDeploymentConfigurationError) {
      return NextResponse.json({ error: error.message, code: 'website_deployment_unavailable' }, { status: 503, headers: headers(req) });
    }
    if (error instanceof WebsiteHostnameProvisioningError) {
      return NextResponse.json({ error: error.message, code: 'website_hostname_unavailable' }, { status: 503, headers: headers(req) });
    }
    if (error instanceof WebsiteHostnameConflictError) {
      return NextResponse.json({ error: 'That website address is already in use. Choose a different website name.', code: 'website_hostname_conflict' }, { status: 409, headers: headers(req) });
    }
    if (isWebsiteSlugUniqueConstraintError(error)) {
      return NextResponse.json({ error: 'That website address is already in use. Choose a different website name.', code: 'website_slug_conflict' }, { status: 409, headers: headers(req) });
    }
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002' && 'meta' in error && JSON.stringify(error.meta).includes('hostname')) {
      return NextResponse.json({ error: 'That website address is already in use. Choose a different website name.', code: 'website_hostname_conflict' }, { status: 409, headers: headers(req) });
    }
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2034') {
      return NextResponse.json({ error: 'Another website update is in progress. Please retry publishing.', code: 'website_publish_conflict' }, { status: 409, headers: headers(req) });
    }
    return NextResponse.json({ error: 'Website could not be published.' }, { status: 500, headers: headers(req) });
  }
}

export const runtime = 'nodejs';
