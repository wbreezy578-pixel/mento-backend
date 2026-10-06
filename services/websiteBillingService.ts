import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import logger from '../lib/logger';
import { isSubscriptionActive } from './planService';

export const WEBSITE_PROJECT_LIMIT = 5;
export const WEBSITE_EDIT_LIMIT_PER_PERIOD = 50;
export const WEBSITE_HOSTING_PRICE_USD = 5;
const configuredGraceDays = process.env.WEBSITE_PAYMENT_GRACE_DAYS;
export const WEBSITE_PAYMENT_GRACE_DAYS = configuredGraceDays === undefined ? 7 : Number(configuredGraceDays);
if (!Number.isSafeInteger(WEBSITE_PAYMENT_GRACE_DAYS) || WEBSITE_PAYMENT_GRACE_DAYS < 0 || WEBSITE_PAYMENT_GRACE_DAYS > 90) {
  throw new Error('WEBSITE_PAYMENT_GRACE_DAYS must be a whole number from 0 to 90.');
}

export type WebsiteAccessMode = 'create' | 'edit';
export type WebsiteHostingState = 'active' | 'grace' | 'suspended';
export type WebsiteHostingAccountSnapshot = {
  tier: 'SITES_1' | 'SITES_3' | 'SITES_5' | null;
  siteLimit: number;
  status: string;
  paidThroughAt: Date | null;
  graceDeadlineAt: Date | null;
  scheduledTier: 'SITES_1' | 'SITES_3' | 'SITES_5' | null;
  scheduledSiteLimit: number | null;
  scheduledEffectiveAt: Date | null;
  scheduledKeptWebsiteIds: unknown;
};

const HOSTING_TIER_LIMITS = { SITES_1: 1, SITES_3: 3, SITES_5: 5 } as const;

export function getWebsiteHostingEntitlement(account: WebsiteHostingAccountSnapshot | null, now = new Date()): {
  status: WebsiteHostingState;
  siteLimit: number;
} {
  if (!account || !account.tier || !['ACTIVE', 'GRACE_PERIOD', 'CANCELLED', 'ON_HOLD'].includes(account.status)) {
    return { status: 'suspended', siteLimit: 0 };
  }

  const paidThrough = account.paidThroughAt && account.paidThroughAt.getTime() >= now.getTime();
  if (paidThrough) {
    return {
      status: account.status === 'GRACE_PERIOD' ? 'grace' : 'active',
      siteLimit: account.siteLimit,
    };
  }

  const inGrace = account.graceDeadlineAt
    && account.graceDeadlineAt.getTime() >= now.getTime()
    && ['GRACE_PERIOD', 'ON_HOLD'].includes(account.status);
  if (inGrace) return { status: 'grace', siteLimit: account.siteLimit };
  return { status: 'suspended', siteLimit: 0 };
}

export function getScheduledWebsiteHostingLimit(account: WebsiteHostingAccountSnapshot, now = new Date()): number | null {
  if (!account.scheduledEffectiveAt || account.scheduledEffectiveAt.getTime() > now.getTime()) return null;
  if (account.scheduledSiteLimit !== null) return account.scheduledSiteLimit;
  return account.scheduledTier ? HOSTING_TIER_LIMITS[account.scheduledTier] : null;
}

export class WebsiteAccessError extends Error {
  status = 403;

  constructor(message: string) {
    super(message);
    this.name = 'WebsiteAccessError';
  }
}

export interface WebsiteQuotaSnapshot {
  activePro: boolean;
  billingWindowStart: Date | null;
  billingWindowEnd: Date | null;
  projectUsed: number;
  projectLimit: number;
  projectRemaining: number;
  editUsed: number;
  editLimit: number;
  editRemaining: number;
}

function getProBillingWindow(userWallet: { subscriptionPeriodStart?: Date | string | null; subscriptionExpiresAt?: Date | string | null; subscriptionStartedAt?: Date | string | null } | null, now = new Date()) {
  if (!userWallet) {
    return { start: null, end: null };
  }

  const start = userWallet.subscriptionPeriodStart ?? userWallet.subscriptionStartedAt ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = userWallet.subscriptionExpiresAt ?? new Date(new Date(start).getTime() + 30 * 24 * 60 * 60 * 1000);
  return {
    start: new Date(start),
    end: new Date(end),
  };
}

export async function getWebsiteBillingSnapshot(userId: string, now = new Date()): Promise<WebsiteQuotaSnapshot> {
  const wallet = await prisma.userWallet.findUnique({
    where: { userId },
    include: { plan: true },
  });

  const activePro = Boolean(wallet?.plan && wallet.plan.name === 'PRO' && isSubscriptionActive(
    wallet.subscriptionStatus,
    wallet.subscriptionExpiresAt,
    wallet.subscriptionPeriodStart ?? wallet.subscriptionStartedAt,
    now,
  ));

  const { start, end } = getProBillingWindow(wallet, now);
  const projectUsed = start && end
    ? await prisma.website.count({
        where: {
          userId,
          deletedAt: null,
          createdAt: { gte: start, lt: end },
        },
      })
    : 0;
  const editUsed = start && end
    ? await prisma.usageLog.count({
        where: {
          userId,
          feature: 'website',
          success: true,
          metadata: { path: ['operationType'], equals: 'website.ai_edit' },
          createdAt: { gte: start, lt: end },
        },
      })
    : 0;

  return {
    activePro,
    billingWindowStart: start,
    billingWindowEnd: end,
    projectUsed,
    projectLimit: WEBSITE_PROJECT_LIMIT,
    projectRemaining: Math.max(WEBSITE_PROJECT_LIMIT - projectUsed, 0),
    editUsed,
    editLimit: WEBSITE_EDIT_LIMIT_PER_PERIOD,
    editRemaining: Math.max(WEBSITE_EDIT_LIMIT_PER_PERIOD - editUsed, 0),
  };
}

export async function assertWebsiteFeatureAccess(userId: string, mode: WebsiteAccessMode, now = new Date()): Promise<WebsiteQuotaSnapshot> {
  const snapshot = await getWebsiteBillingSnapshot(userId, now);

  if (!snapshot.activePro) {
    await recordWebsitePolicyDenial(userId, mode, 'pro_inactive');
    throw new WebsiteAccessError('Website creation and editing require an active Mento Pro subscription.');
  }

  if (mode === 'create' && snapshot.projectUsed >= WEBSITE_PROJECT_LIMIT) {
    await recordWebsitePolicyDenial(userId, mode, 'project_limit');
    throw new WebsiteAccessError(`You reached your 5 website projects limit for this Pro billing period.`);
  }

  if (mode === 'edit' && snapshot.editUsed >= WEBSITE_EDIT_LIMIT_PER_PERIOD) {
    await recordWebsitePolicyDenial(userId, mode, 'edit_limit');
    throw new WebsiteAccessError(`You reached your 50 successful website edits limit for this Pro billing period.`);
  }

  return snapshot;
}

export async function createWebsiteWithinProLimit<T>(
  userId: string,
  create: (tx: Prisma.TransactionClient) => Promise<T>,
  requestId?: string,
  now = new Date(),
): Promise<T> {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "UserWallet" WHERE "userId" = ${userId} FOR UPDATE`;
      const wallet = await tx.userWallet.findUnique({ where: { userId }, include: { plan: true } });
      const activePro = Boolean(wallet?.plan?.name === 'PRO' && isSubscriptionActive(
        wallet.subscriptionStatus,
        wallet.subscriptionExpiresAt,
        wallet.subscriptionPeriodStart ?? wallet.subscriptionStartedAt,
        now,
      ));
      if (!activePro) throw new WebsiteAccessError('Website creation and editing require an active Mento Pro subscription.');

      const { start, end } = getProBillingWindow(wallet, now);
      if (!start || !end) throw new WebsiteAccessError('The Mento Pro billing period could not be resolved.');
      const pendingStart = new Date(Math.max(start.getTime(), now.getTime() - 5 * 60 * 1000));
      const [projects, pendingCreations] = await Promise.all([
        tx.website.count({ where: { userId, deletedAt: null, createdAt: { gte: start, lt: end } } }),
        tx.usageLog.count({
          where: {
            userId,
            feature: 'website',
            metadata: { path: ['operationType'], equals: 'website.generate' },
            success: null,
            createdAt: { gte: pendingStart, lt: end },
            ...(requestId ? { requestId: { not: requestId } } : {}),
          },
        }),
      ]);
      if (projects + pendingCreations >= WEBSITE_PROJECT_LIMIT) {
        throw new WebsiteAccessError('You reached your 5 website projects limit for this Pro billing period.');
      }

      return create(tx);
    });
  } catch (error) {
    if (error instanceof WebsiteAccessError) {
      await recordWebsitePolicyDenial(userId, 'create', 'project_limit_or_pro_inactive');
    }
    throw error;
  }
}

async function recordWebsitePolicyDenial(userId: string, mode: WebsiteAccessMode, reason: string): Promise<void> {
  try {
    await prisma.securityEvent.create({
      data: {
        userId,
        eventType: 'WEBSITE_POLICY_DENIED',
        severity: 'warning',
        details: { mode, reason },
      },
    });
  } catch (error) {
    logger.warn('Website policy denial could not be recorded', {
      userId,
      mode,
      reason,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}

export async function getWebsiteHostingState(websiteId: string, now = new Date()): Promise<{ status: WebsiteHostingState; graceEndsAt: Date | null; lastChargeDate: Date | null }> {
  const accountWebsite = await prisma.website.findUnique({
    where: { id: websiteId },
    select: {
      userId: true,
      user: {
        select: {
          websiteHostingAccount: {
            select: {
              tier: true,
              siteLimit: true,
              status: true,
              paidThroughAt: true,
              graceDeadlineAt: true,
              scheduledTier: true,
              scheduledSiteLimit: true,
              scheduledEffectiveAt: true,
              scheduledKeptWebsiteIds: true,
              currentPeriodStart: true,
            },
          },
        },
      },
    },
  });
  const hostingAccount = accountWebsite?.user.websiteHostingAccount as WebsiteHostingAccountSnapshot & { currentPeriodStart: Date | null } | null;
  if (hostingAccount) {
    const entitlement = getWebsiteHostingEntitlement(hostingAccount, now);
    const scheduledLimit = getScheduledWebsiteHostingLimit(hostingAccount, now);
    const scheduleIsEffective = Boolean(hostingAccount.scheduledEffectiveAt && hostingAccount.scheduledEffectiveAt.getTime() <= now.getTime());
    const siteLimit = scheduleIsEffective ? scheduledLimit ?? 0 : entitlement.siteLimit;
    if (entitlement.status === 'suspended' || siteLimit < 1) {
      return { status: 'suspended', graceEndsAt: hostingAccount.graceDeadlineAt, lastChargeDate: hostingAccount.currentPeriodStart };
    }

    if (accountWebsite?.userId) {
      const publishedWebsites = await prisma.website.findMany({
        where: { userId: accountWebsite.userId, deletedAt: null, status: 'published' },
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
      const keptIds = scheduleIsEffective && Array.isArray(hostingAccount.scheduledKeptWebsiteIds)
        ? hostingAccount.scheduledKeptWebsiteIds.filter((id): id is string => typeof id === 'string')
        : [];
      const ordered = publishedWebsites
        .map((website) => ({
          id: website.id,
          publishedAt: website.deployments.find((deployment) => deployment.id === website.publishedDeploymentId)?.publishedAt
            ?? website.deployments[0]?.publishedAt
            ?? new Date(0),
        }))
        .sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());
      const selected = keptIds
        .map((id) => ordered.find((website) => website.id === id))
        .filter((website): website is (typeof ordered)[number] => Boolean(website))
        .slice(0, siteLimit);
      const selectedIds = new Set(selected.map((website) => website.id));
      for (const website of ordered) {
        if (selectedIds.size >= siteLimit) break;
        selectedIds.add(website.id);
      }
      if (!selectedIds.has(websiteId)) {
        return { status: 'suspended', graceEndsAt: hostingAccount.graceDeadlineAt, lastChargeDate: hostingAccount.currentPeriodStart };
      }
    }

    return {
      status: entitlement.status,
      graceEndsAt: hostingAccount.graceDeadlineAt ?? hostingAccount.paidThroughAt,
      lastChargeDate: hostingAccount.currentPeriodStart,
    };
  }

  const latestCharge = await prisma.paymentTransaction.findFirst({
    where: {
      type: 'WEBSITE_HOSTING',
      status: 'SUCCEEDED',
      metadata: {
        path: ['websiteId'],
        equals: websiteId,
      } as never,
    },
    orderBy: { createdAt: 'desc' },
  });

  let billingPeriodEnd: Date;
  let lastChargeDate: Date | null = null;
  if (latestCharge) {
    const metadata = typeof latestCharge.metadata === 'object' && latestCharge.metadata !== null
      ? latestCharge.metadata as Record<string, unknown>
      : {};
    const recordedPeriodEnd = metadata.billingPeriodEnd ? new Date(String(metadata.billingPeriodEnd)) : null;
    billingPeriodEnd = recordedPeriodEnd && !Number.isNaN(recordedPeriodEnd.getTime())
      ? recordedPeriodEnd
      : new Date(latestCharge.createdAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    lastChargeDate = latestCharge.createdAt;
  } else {
    const deployment = await prisma.websiteDeployment.findFirst({
      where: { websiteId, status: 'published' },
      orderBy: { publishedAt: 'desc' },
      select: { publishedAt: true, createdAt: true },
    });
    if (!deployment) return { status: 'suspended', graceEndsAt: null, lastChargeDate: null };
    billingPeriodEnd = deployment.publishedAt ?? deployment.createdAt;
  }

  const graceEndsAt = new Date(billingPeriodEnd.getTime() + WEBSITE_PAYMENT_GRACE_DAYS * 24 * 60 * 60 * 1000);

  if (now <= billingPeriodEnd) {
    return { status: 'active', graceEndsAt, lastChargeDate };
  }

  if (now <= graceEndsAt) {
    return { status: 'grace', graceEndsAt, lastChargeDate };
  }

  return { status: 'suspended', graceEndsAt, lastChargeDate };
}
