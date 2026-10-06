import { NextResponse } from 'next/server';
import { prisma } from '../../../../lib/prisma';
import { AIRequestGatewayError, authenticateAIRequest } from '../../../../lib/aiSecurityGateway';
import { buildCorsHeaders } from '../../../../lib/securityHeaders';
import { getConfiguredGooglePlayHostingProductId } from '../../../../services/nativeStoreService';
import {
  getScheduledWebsiteHostingLimit,
  getWebsiteBillingSnapshot,
  getWebsiteHostingEntitlement,
  getWebsiteHostingState,
  WEBSITE_HOSTING_PRICE_USD,
  WEBSITE_PAYMENT_GRACE_DAYS,
  type WebsiteHostingAccountSnapshot,
} from '../../../../services/websiteBillingService';

function headers(req: Request) {
  return { ...buildCorsHeaders(req.headers.get('origin')), 'Cache-Control': 'no-store, private' };
}

export async function GET(req: Request) {
  try {
    const user = await authenticateAIRequest(req);
    const [usage, websites, payments, account] = await Promise.all([
      getWebsiteBillingSnapshot(user.id),
      prisma.website.findMany({
        where: { userId: user.id, deletedAt: null },
        select: { id: true, title: true, slug: true, status: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.paymentTransaction.findMany({
        where: { userId: user.id, type: 'WEBSITE_HOSTING' },
        select: { id: true, status: true, amountUsd: true, currency: true, description: true, receiptNumber: true, createdAt: true, metadata: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      prisma.websiteHostingAccount.findUnique({ where: { userId: user.id } }),
    ]);

    const hosting = await Promise.all(websites.map(async (website) => ({
      websiteId: website.id,
      title: website.title,
      slug: website.slug,
      published: website.status === 'published',
      ...(await getWebsiteHostingState(website.id)),
    })));
    const hostingAccount = account as (WebsiteHostingAccountSnapshot & {
      providerPurchaseTokenHash: string | null;
    }) | null;
    const hostingEntitlement = getWebsiteHostingEntitlement(hostingAccount);
    const scheduledLimit = hostingAccount ? getScheduledWebsiteHostingLimit(hostingAccount) : null;
    const effectiveLimit = hostingAccount?.scheduledEffectiveAt && hostingAccount.scheduledEffectiveAt <= new Date()
      ? scheduledLimit ?? 0
      : hostingEntitlement.siteLimit;
    const liveSites = hosting.filter((site) => site.published && site.status !== 'suspended').length;
    const currentStorePurchase = hostingAccount?.providerPurchaseTokenHash
      ? await prisma.storePurchase.findFirst({
          where: {
            userId: user.id,
            provider: 'GOOGLE_PLAY',
            productId: getConfiguredGooglePlayHostingProductId(),
            originalTransactionId: hostingAccount.providerPurchaseTokenHash,
          },
          select: { autoRenewing: true },
        })
      : null;
    const titleById = new Map(websites.map((website) => [website.id, website.title]));
    const history = payments.map((payment) => {
      const metadata = payment.metadata && typeof payment.metadata === 'object' && !Array.isArray(payment.metadata)
        ? payment.metadata as Record<string, unknown>
        : {};
      const websiteId = typeof metadata.websiteId === 'string' ? metadata.websiteId : null;
      return {
        id: payment.id,
        websiteId,
        websiteTitle: websiteId ? titleById.get(websiteId) ?? 'Website' : 'Website',
        status: payment.status,
        amountUsd: payment.amountUsd,
        currency: payment.currency,
        description: payment.description,
        receiptNumber: payment.receiptNumber,
        createdAt: payment.createdAt.toISOString(),
        billingPeriodStart: typeof metadata.billingPeriodStart === 'string' ? metadata.billingPeriodStart : null,
        billingPeriodEnd: typeof metadata.billingPeriodEnd === 'string' ? metadata.billingPeriodEnd : null,
      };
    });

    return NextResponse.json({
      usage,
      hosting,
      hostingAccount: hostingAccount ? {
        tier: hostingAccount.tier,
        status: hostingEntitlement.status,
        liveSites,
        siteLimit: effectiveLimit,
        availableSlots: Math.max(0, effectiveLimit - liveSites),
        paidThroughAt: hostingAccount.paidThroughAt?.toISOString() ?? null,
        graceDeadlineAt: hostingAccount.graceDeadlineAt?.toISOString() ?? null,
        autoRenewing: currentStorePurchase?.autoRenewing ?? null,
        scheduledTier: hostingAccount.scheduledTier,
        scheduledSiteLimit: hostingAccount.scheduledSiteLimit,
        scheduledEffectiveAt: hostingAccount.scheduledEffectiveAt?.toISOString() ?? null,
        scheduledKeptWebsiteIds: Array.isArray(hostingAccount.scheduledKeptWebsiteIds)
          ? hostingAccount.scheduledKeptWebsiteIds.filter((id): id is string => typeof id === 'string')
          : [],
      } : {
        tier: null,
        status: 'suspended',
        liveSites: 0,
        siteLimit: 0,
        availableSlots: 0,
        paidThroughAt: null,
        graceDeadlineAt: null,
        autoRenewing: null,
        scheduledTier: null,
        scheduledSiteLimit: null,
        scheduledEffectiveAt: null,
        scheduledKeptWebsiteIds: [],
      },
      history,
      hostingPriceUsdPerSitePerMonth: WEBSITE_HOSTING_PRICE_USD,
      paymentGraceDays: WEBSITE_PAYMENT_GRACE_DAYS,
    }, { headers: headers(req) });
  } catch (error) {
    if (error instanceof AIRequestGatewayError) return NextResponse.json(error.body, { status: error.status, headers: { ...error.headers, ...headers(req) } });
    return NextResponse.json({ error: 'Website billing details could not be loaded.' }, { status: 500, headers: headers(req) });
  }
}

export const runtime = 'nodejs';
