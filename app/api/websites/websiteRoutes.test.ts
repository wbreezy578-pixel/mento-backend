import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticateAIRequest: vi.fn(),
  enforceAIGatewayRateLimit: vi.fn(),
  executeAIRequest: vi.fn(),
  getClientIp: vi.fn(),
  requireClientAIRequestId: vi.fn(),
  secureAITextInput: vi.fn(),
  askGemini: vi.fn(),
  getTutorLanguage: vi.fn(),
  buildTutorLanguageInstruction: vi.fn(),
  website: {
    create: vi.fn(),
    count: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
  },
  websiteVersion: { findFirst: vi.fn(), create: vi.fn() },
  websiteDeployment: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  websiteDomain: { create: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  websiteReport: { create: vi.fn(), findMany: vi.fn() },
  userWallet: { findUnique: vi.fn() },
  usageLog: { count: vi.fn() },
  paymentTransaction: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  websiteHostingAccount: { findUnique: vi.fn() },
  storePurchase: { findFirst: vi.fn() },
  securityEvent: { create: vi.fn() },
  transaction: vi.fn(),
  uploadWebsiteDeployment: vi.fn(),
  deleteWebsiteDeploymentArtifacts: vi.fn(),
  loggerError: vi.fn(),
  ensureWebsiteWorkerDomain: vi.fn(),
}));

vi.mock('../../../lib/aiSecurityGateway', () => ({
  AIRequestGatewayError: class AIRequestGatewayError extends Error {
    status = 500;
    body: unknown = null;
    headers = {};
  },
  authenticateAIRequest: mocks.authenticateAIRequest,
  enforceAIGatewayRateLimit: mocks.enforceAIGatewayRateLimit,
  executeAIRequest: mocks.executeAIRequest,
  getClientIp: mocks.getClientIp,
  requireClientAIRequestId: mocks.requireClientAIRequestId,
  secureAITextInput: mocks.secureAITextInput,
}));

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    website: mocks.website,
    websiteVersion: mocks.websiteVersion,
    websiteDeployment: mocks.websiteDeployment,
    websiteDomain: mocks.websiteDomain,
    websiteReport: mocks.websiteReport,
    userWallet: mocks.userWallet,
    usageLog: mocks.usageLog,
    paymentTransaction: mocks.paymentTransaction,
    websiteHostingAccount: mocks.websiteHostingAccount,
    storePurchase: mocks.storePurchase,
    securityEvent: mocks.securityEvent,
    $transaction: mocks.transaction,
  },
}));

vi.mock('../../../services/geminiService', () => ({ askGemini: mocks.askGemini }));
vi.mock('../../../services/websiteDeploymentStorage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/websiteDeploymentStorage')>()),
  uploadWebsiteDeployment: mocks.uploadWebsiteDeployment,
  deleteWebsiteDeploymentArtifacts: mocks.deleteWebsiteDeploymentArtifacts,
}));
vi.mock('../../../services/websiteCloudflareDomainService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/websiteCloudflareDomainService')>()),
  ensureWebsiteWorkerDomain: mocks.ensureWebsiteWorkerDomain,
}));
vi.mock('../../../lib/userSettings', () => ({
  getTutorLanguage: mocks.getTutorLanguage,
  buildTutorLanguageInstruction: mocks.buildTutorLanguageInstruction,
}));
vi.mock('../../../lib/logger', () => ({ default: { error: mocks.loggerError, info: vi.fn(), warn: vi.fn() } }));

import { GET as listWebsites } from './route';
import { GET as getWebsiteBilling } from './billing/route';
import { POST as generateWebsite } from './generate/route';
import { PATCH as updateWebsite } from './[websiteId]/route';
import { POST as editWebsite } from './[websiteId]/edit/route';
import { POST as restoreWebsite } from './[websiteId]/restore/route';
import { POST as renameWebsite } from './[websiteId]/rename/route';
import { POST as duplicateWebsite } from './[websiteId]/duplicate/route';
import { POST as publishWebsite } from './[websiteId]/publish/route';
import { POST as unpublishWebsite } from './[websiteId]/unpublish/route';
import { GET as publicWebsite } from './public/route';
import { createDraftWebsiteSlug, isWebsiteSlugUniqueConstraintError, slugifyWebsiteName } from '../../../services/websiteDeploymentService';
import { getWebsiteHostingEntitlement } from '../../../services/websiteBillingService';

const content = {
  title: 'Bella Restaurant',
  description: 'Swahili dishes and seafood in Mombasa.',
  theme: { primaryColor: '#A84D35' },
  pages: [{ title: 'Home', slug: 'home', sections: [{ type: 'hero', title: 'Taste the coast', body: 'Fresh seafood and Swahili favorites.' }] }],
  menuCategories: [{ name: 'Main Dishes', items: [{ name: 'Chicken Biryani', description: 'Spiced rice with chicken', price: '650', currency: 'KSh', available: true }] }],
  galleryImageUrls: [],
  contact: { address: 'Mombasa', phone: '', whatsappNumber: '' },
};

const ownerWebsite = {
  id: 'site-1',
  userId: 'user-1',
  type: 'restaurant',
  title: content.title,
  content,
  revision: 2,
  currentVersion: 1,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-01T00:00:00Z'),
};

function activeHostingAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: 'hosting-account-1',
    userId: 'user-1',
    tier: 'SITES_1',
    siteLimit: 1,
    status: 'ACTIVE',
    paidThroughAt: new Date('2099-01-01T00:00:00.000Z'),
    graceDeadlineAt: null,
    scheduledTier: null,
    scheduledSiteLimit: null,
    scheduledEffectiveAt: null,
    scheduledKeptWebsiteIds: null,
    ...overrides,
  };
}

function request(url: string, body: unknown, method = 'POST') {
  return new Request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('website slug helpers', () => {
  it('creates canonical slugs and rejects names without a safe slug', () => {
    expect(slugifyWebsiteName('  Bella & Table!  ')).toBe('bella-and-table');
    expect(slugifyWebsiteName('A'.repeat(70))).toBe('a'.repeat(60));
    expect(slugifyWebsiteName('東京')).toBe('');
  });

  it('creates distinct canonical draft slugs', () => {
    const first = createDraftWebsiteSlug('Bella Restaurant');
    const second = createDraftWebsiteSlug('Bella Restaurant');

    expect(first).not.toBe(second);
    expect(first).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/);
    expect(first.length).toBeLessThanOrEqual(60);
  });

  it('recognizes only slug uniqueness violations', () => {
    expect(isWebsiteSlugUniqueConstraintError({ code: 'P2002', meta: { target: ['slug'] } })).toBe(true);
    expect(isWebsiteSlugUniqueConstraintError({ code: 'P2002', meta: { target: ['websiteId', 'version'] } })).toBe(false);
  });
});

describe('website hosting entitlement effective dates', () => {
  const now = new Date('2026-10-05T10:00:00.000Z');
  const baseAccount = activeHostingAccount({
    status: 'CANCELLED',
    paidThroughAt: new Date('2026-10-06T10:00:00.000Z'),
  });

  it('keeps a canceled subscription active through Google-verified paid-through', () => {
    expect(getWebsiteHostingEntitlement(baseAccount, now)).toEqual({ status: 'active', siteLimit: 1 });
  });

  it('keeps a verified hold in grace only until its grace deadline', () => {
    const onHold = activeHostingAccount({
      status: 'ON_HOLD',
      paidThroughAt: new Date('2026-10-04T10:00:00.000Z'),
      graceDeadlineAt: new Date('2026-10-06T10:00:00.000Z'),
    });

    expect(getWebsiteHostingEntitlement(onHold, now)).toEqual({ status: 'grace', siteLimit: 1 });
    expect(getWebsiteHostingEntitlement(onHold, new Date('2026-10-06T10:00:01.000Z'))).toEqual({ status: 'suspended', siteLimit: 0 });
  });

  it('does not extend a canceled subscription beyond its paid-through date without verified grace', () => {
    expect(getWebsiteHostingEntitlement({
      ...baseAccount,
      paidThroughAt: new Date('2026-10-04T10:00:00.000Z'),
      graceDeadlineAt: null,
    }, now)).toEqual({ status: 'suspended', siteLimit: 0 });
  });
});

describe('Websites API ownership and AI contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateAIRequest.mockResolvedValue({ id: 'user-1' });
    mocks.enforceAIGatewayRateLimit.mockResolvedValue(undefined);
    mocks.getClientIp.mockReturnValue('127.0.0.1');
    mocks.requireClientAIRequestId.mockImplementation((_req: Request, id: string) => id);
    mocks.secureAITextInput.mockResolvedValue({ sanitizedInput: 'Create a restaurant site.' });
    mocks.getTutorLanguage.mockResolvedValue('en');
    mocks.buildTutorLanguageInstruction.mockReturnValue('Respond in English.');
    mocks.askGemini.mockResolvedValue(JSON.stringify(content));
    mocks.website.create.mockResolvedValue({ ...ownerWebsite, versions: [{ id: 'version-1', version: 1, source: 'initial', summary: 'Initial website', content }] });
    mocks.website.count.mockResolvedValue(0);
    mocks.website.findUnique.mockResolvedValue(null);
    mocks.userWallet.findUnique.mockResolvedValue({
      userId: 'user-1',
      subscriptionStatus: 'active',
      subscriptionExpiresAt: new Date('2099-01-01T00:00:00Z'),
      subscriptionPeriodStart: new Date('2026-10-01T00:00:00Z'),
      subscriptionStartedAt: new Date('2026-10-01T00:00:00Z'),
      plan: { name: 'PRO' },
    });
    mocks.usageLog.count.mockResolvedValue(0);
    mocks.securityEvent.create.mockResolvedValue({ id: 'security-event-1' });
    mocks.paymentTransaction.findFirst.mockResolvedValue({
      id: 'payment-1',
      metadata: { websiteId: 'site-1', billingPeriodEnd: '2099-12-01T00:00:00.000Z' },
      createdAt: new Date('2026-10-01T00:00:00Z'),
    });
    mocks.websiteHostingAccount.findUnique.mockResolvedValue(null);
    mocks.websiteVersion.findFirst.mockResolvedValue({ content });
    mocks.websiteDomain.findFirst.mockResolvedValue(null);
    mocks.websiteDomain.findUnique.mockResolvedValue(null);
    mocks.websiteDomain.create.mockResolvedValue({ id: 'website-domain-1', hostname: 'web-bella-restaurant.trymentoapp.com' });
    mocks.websiteDomain.update.mockResolvedValue({ id: 'website-domain-1' });
    mocks.websiteDomain.updateMany.mockResolvedValue({ count: 1 });
    mocks.websiteDeployment.updateMany.mockResolvedValue({ count: 1 });
    mocks.uploadWebsiteDeployment.mockResolvedValue({
      deploymentId: 'deployment-1',
      r2Prefix: 'websites/site-1/deployments/deployment-1',
      manifestKey: 'websites/site-1/deployments/deployment-1/manifest.json',
      artifactHash: 'a'.repeat(64),
      artifactSize: 100,
      manifest: {},
    });
    mocks.deleteWebsiteDeploymentArtifacts.mockResolvedValue(undefined);
    mocks.storePurchase.findFirst.mockResolvedValue(null);
    mocks.transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) => callback({
      $queryRaw: vi.fn().mockResolvedValue([]),
      userWallet: { findUnique: mocks.userWallet.findUnique },
      website: {
        create: mocks.website.create,
        count: mocks.website.count,
        updateMany: mocks.website.updateMany,
        findFirst: mocks.website.findFirst,
      },
      websiteVersion: mocks.websiteVersion,
      websiteDomain: mocks.websiteDomain,
      usageLog: { count: mocks.usageLog.count },
    }));
    mocks.executeAIRequest.mockImplementation(async (options: any) => {
      const result = await options.callback({
        billingDecision: { modelUsed: 'gemini-test' },
        sanitizedInput: 'Create a restaurant site.',
        reportUsage: vi.fn(),
        reportProviderAttempt: vi.fn().mockResolvedValue(1),
      });
      await options.beforeFinalize?.(result);
      return { result, billingDecision: { allowed: true, remainingUsage: 0 } };
    });
  });

  it('lists only the authenticated user\'s non-deleted websites', async () => {
    mocks.website.findMany.mockResolvedValue([{
      ...ownerWebsite,
      status: 'published',
      deletedAt: null,
      versions: [{ id: 'version-1', version: 1, source: 'initial', summary: 'Initial website', changeType: 'initial', createdAt: new Date() }],
      domains: [{ hostname: 'web-bella.trymentoapp.com' }],
    }]);

    const response = await listWebsites(new Request('https://mento.test/api/websites', { method: 'GET' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.website.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-1', deletedAt: null },
      include: expect.objectContaining({
        domains: { where: { kind: 'mento_subdomain', status: 'active' }, select: { hostname: true }, take: 1 },
      }),
    }));
    expect(body.websites[0].status).toBe('published');
    expect(body.websites[0].domains[0].hostname).toBe('web-bella.trymentoapp.com');
  });

  it('returns owner-scoped Pro usage, hosting status, and billing history', async () => {
    vi.stubEnv('GOOGLE_PLAY_BILLING_MODE', 'production');
    vi.stubEnv('GOOGLE_PLAY_PACKAGE_NAME', 'com.trymentoapp.mento');
    mocks.websiteHostingAccount.findUnique.mockResolvedValueOnce(activeHostingAccount({
      tier: 'SITES_3',
      siteLimit: 3,
      providerPurchaseTokenHash: 'token-hash',
      paidThroughAt: new Date('2099-12-01T00:00:00Z'),
    }));
    mocks.storePurchase.findFirst.mockResolvedValueOnce({ autoRenewing: true });
    mocks.website.findMany.mockResolvedValue([{ id: 'site-1', title: 'Bella Restaurant', slug: 'bella-restaurant', status: 'published' }]);
    mocks.paymentTransaction.findMany.mockResolvedValue([{
      id: 'hosting-payment-1',
      status: 'SUCCEEDED',
      amountUsd: 5,
      currency: 'USD',
      description: 'Website hosting for Bella Restaurant',
      receiptNumber: 'RCPT-HOSTING',
      createdAt: new Date('2026-10-01T00:00:00Z'),
      metadata: { websiteId: 'site-1', billingPeriodStart: '2026-10-01T00:00:00.000Z', billingPeriodEnd: '2099-12-01T00:00:00.000Z' },
    }]);

    const response = await getWebsiteBilling(new Request('https://mento.test/api/websites/billing', { method: 'GET' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.usage).toEqual(expect.objectContaining({ projectLimit: 5, editLimit: 50, activePro: true }));
    expect(body.hosting[0]).toEqual(expect.objectContaining({ websiteId: 'site-1', status: 'active' }));
    expect(body.hostingAccount).toEqual(expect.objectContaining({
      tier: 'SITES_3',
      status: 'active',
      siteLimit: 3,
      autoRenewing: true,
      paidThroughAt: '2099-12-01T00:00:00.000Z',
    }));
    expect(body.history[0]).toEqual(expect.objectContaining({ websiteId: 'site-1', websiteTitle: 'Bella Restaurant', amountUsd: 5 }));
    expect(mocks.website.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-1', deletedAt: null } }));
    expect(mocks.paymentTransaction.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-1', type: 'WEBSITE_HOSTING' } }));
  });

  it('creates an owner-bound website and one initial version through website AI usage', async () => {
    mocks.askGemini.mockResolvedValueOnce('invalid JSON');
    const response = await generateWebsite(request('https://mento.test/api/websites/generate', {
      title: 'Bella Restaurant',
      type: 'restaurant',
      brief: 'Swahili and seafood dishes in Mombasa.',
      requestId: 'website-create-1234',
    }));

    expect(response.status).toBe(201);
    expect(mocks.askGemini).toHaveBeenCalledTimes(2);
    expect(mocks.askGemini.mock.calls.map((call) => call[5])).toEqual([
      { responseMimeType: 'application/json', maxOutputTokens: 8192 },
      { responseMimeType: 'application/json', maxOutputTokens: 8192 },
    ]);
    expect(mocks.executeAIRequest).toHaveBeenCalledWith(expect.objectContaining({
      feature: 'website',
      amount: 1,
      metadata: expect.objectContaining({ operationType: 'website.generate' }),
    }));
    expect(mocks.website.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId: 'user-1',
        type: 'restaurant',
        versions: { create: expect.objectContaining({ version: 1, source: 'initial' }) },
      }),
    }));
  });

  it('blocks a sixth project in the current Pro billing period before AI generation', async () => {
    mocks.website.count.mockResolvedValue(5);

    const response = await generateWebsite(request('https://mento.test/api/websites/generate', {
      title: 'Another site',
      type: 'restaurant',
      brief: 'A coastal restaurant.',
      requestId: 'website-create-over-limit',
    }));

    expect(response.status).toBe(403);
    expect(mocks.executeAIRequest).not.toHaveBeenCalled();
    expect(mocks.website.count).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: 'user-1', deletedAt: null }) }));
    expect(mocks.securityEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'WEBSITE_POLICY_DENIED', details: { mode: 'create', reason: 'project_limit' } }) }));
  });

  it('renames a website only for the authenticated owner', async () => {
    mocks.website.findFirst.mockResolvedValueOnce({ ...ownerWebsite, currentVersion: 2, status: 'draft', slug: 'bella-restaurant' }).mockResolvedValueOnce(null);
    const websiteUpdate = vi.fn().mockResolvedValue({ ...ownerWebsite, title: 'Bella Mombasa', currentVersion: 3, slug: 'bella-mombasa' });
    mocks.transaction.mockImplementationOnce(async (callback: (tx: any) => Promise<any>) => callback({
      website: { update: websiteUpdate },
      websiteVersion: { create: vi.fn().mockResolvedValue({ id: 'version-3', version: 3, source: 'rename', summary: 'Renamed website to Bella Mombasa', changeType: 'rename' }) },
    }));

    const response = await renameWebsite(request('https://mento.test/api/websites/site-1/rename', { name: 'Bella Mombasa' }), { params: Promise.resolve({ websiteId: 'site-1' }) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.website.title).toBe('Bella Mombasa');
    expect(websiteUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ slug: 'bella-mombasa' }) }));
    expect(body.version.changeType).toBe('rename');
  });

  it('rejects renaming to a website address already in use', async () => {
    mocks.website.findFirst.mockResolvedValueOnce({ ...ownerWebsite, slug: 'bella-restaurant', currentVersion: 2 })
      .mockResolvedValueOnce({ id: 'other-site' });

    const response = await renameWebsite(request('https://mento.test/api/websites/site-1/rename', { name: 'Bella Mombasa' }), { params: Promise.resolve({ websiteId: 'site-1' }) });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe('website_slug_conflict');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('returns a slug conflict when a concurrent rename wins the unique-slug race', async () => {
    mocks.website.findFirst.mockResolvedValueOnce({ ...ownerWebsite, slug: 'bella-restaurant', currentVersion: 2 })
      .mockResolvedValueOnce(null);
    mocks.transaction.mockRejectedValueOnce({ code: 'P2002', meta: { target: ['slug'] } });

    const response = await renameWebsite(request('https://mento.test/api/websites/site-1/rename', { name: 'Bella Mombasa' }), { params: Promise.resolve({ websiteId: 'site-1' }) });

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('website_slug_conflict');
  });

  it('rejects a website name that cannot produce a canonical slug', async () => {
    const response = await renameWebsite(request('https://mento.test/api/websites/site-1/rename', { name: '東京' }), { params: Promise.resolve({ websiteId: 'site-1' }) });

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('invalid_website_slug');
    expect(mocks.website.findFirst).not.toHaveBeenCalled();
  });

  it('duplicates a website into a new draft for the same owner', async () => {
    mocks.website.findFirst.mockResolvedValue(ownerWebsite);
    mocks.transaction.mockImplementationOnce(async (callback: (tx: any) => Promise<any>) => callback({
      $queryRaw: vi.fn().mockResolvedValue([]),
      userWallet: { findUnique: mocks.userWallet.findUnique },
      website: {
        create: vi.fn().mockResolvedValue({ ...ownerWebsite, id: 'site-2', title: 'Bella Restaurant Copy', status: 'draft', currentVersion: 1 }),
        count: mocks.website.count,
      },
      usageLog: { count: mocks.usageLog.count },
    }));

    const response = await duplicateWebsite(request('https://mento.test/api/websites/site-1/duplicate', {}), { params: Promise.resolve({ websiteId: 'site-1' }) });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.website.id).toBe('site-2');
    expect(body.website.status).toBe('draft');
  });

  it('publishes a draft and stores the published version, then unpublishes it back to draft', async () => {
    mocks.website.findFirst.mockResolvedValueOnce({ ...ownerWebsite, status: 'draft', revision: 2, currentVersion: 2, publishedVersion: null })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...ownerWebsite, status: 'published', revision: 2, currentVersion: 2, publishedVersion: 2 });
    const deploymentCreate = vi.fn().mockResolvedValue({ id: 'deployment-1', websiteId: 'site-1', version: 2, status: 'published', hostname: 'bella-restaurant.mento.site', storagePath: 'websites/site-1/deployments/2', publishedAt: new Date() });
    const websitePublishUpdate = vi.fn().mockResolvedValue({ ...ownerWebsite, status: 'published', slug: 'bella-restaurant', publishedVersion: 2, publishedDeploymentId: 'deployment-1', currentVersion: 2, revision: 2 });
    mocks.transaction.mockImplementationOnce(async (callback: (tx: any) => Promise<any>) => callback({
      $queryRaw: vi.fn().mockResolvedValue([]),
      websiteHostingAccount: { findUnique: vi.fn().mockResolvedValue(activeHostingAccount()), update: vi.fn() },
      websiteDeployment: { create: deploymentCreate, updateMany: mocks.websiteDeployment.updateMany },
      websiteDomain: mocks.websiteDomain,
      website: { count: vi.fn().mockResolvedValue(0), findFirst: vi.fn().mockResolvedValue(null), update: websitePublishUpdate },
    }));
    const unpublishDeploymentUpdate = vi.fn().mockResolvedValue({ count: 1 });
    mocks.transaction.mockImplementationOnce(async (callback: (tx: any) => Promise<any>) => callback({
      website: {
        findFirst: vi.fn().mockResolvedValue({ publishedDeploymentId: 'deployment-1' }),
        update: mocks.website.update,
      },
      websiteDeployment: { updateMany: unpublishDeploymentUpdate },
      websiteDomain: mocks.websiteDomain,
    }));
    mocks.website.update.mockResolvedValueOnce({ ...ownerWebsite, status: 'draft', publishedVersion: null, publishedDeploymentId: null, currentVersion: 2, revision: 2 });

    const publishResponse = await publishWebsite(request('https://mento.test/api/websites/site-1/publish', { version: 2, revision: 2 }), { params: Promise.resolve({ websiteId: 'site-1' }) });
    const publishBody = await publishResponse.json();

    expect(publishResponse.status).toBe(200);
    expect(mocks.ensureWebsiteWorkerDomain).toHaveBeenCalledWith('web-bella-restaurant.trymentoapp.com');
    expect(mocks.transaction).toHaveBeenCalled();
    expect(deploymentCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      hostname: 'web-bella-restaurant.trymentoapp.com',
      r2Prefix: 'websites/site-1/deployments/deployment-1',
      manifestKey: 'websites/site-1/deployments/deployment-1/manifest.json',
    }) }));
    expect(websitePublishUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ slug: 'bella-restaurant' }) }));
    expect(publishBody.website.status).toBe('published');
    expect(publishBody.website.slug).toBe('bella-restaurant');
    expect(publishBody.hostname).toBe('web-bella-restaurant.trymentoapp.com');
    expect(publishBody.website.publishedVersion).toBe(2);
    expect(publishBody.website.publishedDeploymentId).toBe('deployment-1');

    const unpublishResponse = await unpublishWebsite(request('https://mento.test/api/websites/site-1/unpublish', { revision: 2 }), { params: Promise.resolve({ websiteId: 'site-1' }) });
    const unpublishBody = await unpublishResponse.json();

    expect(unpublishResponse.status).toBe(200);
    expect(unpublishBody.website.status).toBe('draft');
    expect(unpublishBody.website.publishedVersion).toBeNull();
    expect(unpublishBody.website.publishedDeploymentId).toBeNull();
    expect(unpublishDeploymentUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'deployment-1', websiteId: 'site-1', status: 'published' },
      data: expect.objectContaining({ status: 'paused', unpublishedAt: expect.any(Date) }),
    }));
  });

  it('requires an active hosting entitlement before publishing', async () => {
    mocks.website.findFirst.mockResolvedValueOnce({ ...ownerWebsite, status: 'draft', revision: 2, currentVersion: 2 })
      .mockResolvedValueOnce(null);
    mocks.transaction.mockImplementationOnce(async (callback: (tx: any) => Promise<any>) => callback({
      $queryRaw: vi.fn().mockResolvedValue([]),
      websiteHostingAccount: { findUnique: vi.fn().mockResolvedValue(null) },
      website: { count: vi.fn(), findFirst: vi.fn() },
      websiteDeployment: { create: vi.fn() },
    }));

    const response = await publishWebsite(request('https://mento.test/api/websites/site-1/publish', { version: 2, revision: 2 }), { params: Promise.resolve({ websiteId: 'site-1' }) });

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('website_hosting_required');
    expect(mocks.websiteDeployment.create).not.toHaveBeenCalled();
    expect(mocks.ensureWebsiteWorkerDomain).not.toHaveBeenCalled();
  });

  it('allows publishing throughout the verified paid-through period during a payment hold', async () => {
    mocks.website.findFirst.mockResolvedValueOnce({ ...ownerWebsite, status: 'draft', revision: 2, currentVersion: 2 })
      .mockResolvedValueOnce(null);
    const deploymentCreate = vi.fn().mockResolvedValue({ id: 'deployment-held', status: 'published' });
    const websiteUpdate = vi.fn().mockResolvedValue({ ...ownerWebsite, status: 'published' });
    mocks.transaction.mockImplementationOnce(async (callback: (tx: any) => Promise<any>) => callback({
      $queryRaw: vi.fn().mockResolvedValue([]),
      websiteHostingAccount: {
        findUnique: vi.fn().mockResolvedValue(activeHostingAccount({
          status: 'ON_HOLD',
          paidThroughAt: new Date(Date.now() + 60_000),
        })),
      },
      website: { count: vi.fn().mockResolvedValue(0), findFirst: vi.fn().mockResolvedValue(null), update: websiteUpdate },
      websiteDeployment: { create: deploymentCreate, updateMany: mocks.websiteDeployment.updateMany },
      websiteDomain: mocks.websiteDomain,
    }));

    const response = await publishWebsite(request('https://mento.test/api/websites/site-1/publish', { version: 2, revision: 2 }), { params: Promise.resolve({ websiteId: 'site-1' }) });

    expect(response.status).toBe(200);
    expect(deploymentCreate).toHaveBeenCalled();
  });

  it('rejects a publish that would exceed hosting capacity inside the locked transaction', async () => {
    mocks.website.findFirst.mockResolvedValueOnce({ ...ownerWebsite, status: 'draft', revision: 2, currentVersion: 2 })
      .mockResolvedValueOnce(null);
    const deploymentCreate = vi.fn();
    mocks.transaction.mockImplementationOnce(async (callback: (tx: any) => Promise<any>) => callback({
      $queryRaw: vi.fn().mockResolvedValue([]),
      websiteHostingAccount: { findUnique: vi.fn().mockResolvedValue(activeHostingAccount()) },
      website: { count: vi.fn().mockResolvedValue(1), findFirst: vi.fn().mockResolvedValue(null) },
      websiteDeployment: { create: deploymentCreate },
    }));

    const response = await publishWebsite(request('https://mento.test/api/websites/site-1/publish', { version: 2, revision: 2 }), { params: Promise.resolve({ websiteId: 'site-1' }) });

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('website_hosting_capacity_reached');
    expect(deploymentCreate).not.toHaveBeenCalled();
    expect(mocks.ensureWebsiteWorkerDomain).not.toHaveBeenCalled();
  });

  it('serializes simultaneous publishes so an account cannot exceed one live slot', async () => {
    const secondWebsite = {
      ...ownerWebsite,
      id: 'site-2',
      title: 'Second Restaurant',
      revision: 1,
      currentVersion: 1,
    };
    mocks.website.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      if (where.slug) return null;
      if (where.id === 'site-1') return { ...ownerWebsite, status: 'draft' };
      if (where.id === 'site-2') return { ...secondWebsite, status: 'draft' };
      return null;
    });

    let liveSiteCount = 0;
    let deploymentId = 0;
    let transactionQueue = Promise.resolve();
    mocks.transaction.mockImplementation((callback: (tx: any) => Promise<unknown>) => {
      const currentTransaction = transactionQueue.then(async () => callback({
        $queryRaw: vi.fn().mockResolvedValue([]),
        websiteHostingAccount: { findUnique: vi.fn().mockResolvedValue(activeHostingAccount()) },
        website: {
          count: vi.fn().mockImplementation(async () => liveSiteCount),
          findFirst: vi.fn().mockResolvedValue(null),
          update: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) => {
            liveSiteCount += 1;
            return { ...ownerWebsite, id: where.id, status: 'published' };
          }),
        },
        websiteDomain: mocks.websiteDomain,
        websiteDeployment: {
          create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
            ...data,
            id: `deployment-${++deploymentId}`,
          })),
          updateMany: mocks.websiteDeployment.updateMany,
        },
      }));
      transactionQueue = currentTransaction.then(() => undefined, () => undefined);
      return currentTransaction;
    });

    const [firstResponse, secondResponse] = await Promise.all([
      publishWebsite(request('https://mento.test/api/websites/site-1/publish', { revision: 2 }), { params: Promise.resolve({ websiteId: 'site-1' }) }),
      publishWebsite(request('https://mento.test/api/websites/site-2/publish', { revision: 1 }), { params: Promise.resolve({ websiteId: 'site-2' }) }),
    ]);

    expect([firstResponse.status, secondResponse.status].sort()).toEqual([200, 409]);
    expect(liveSiteCount).toBe(1);
    const failure = firstResponse.status === 409 ? await firstResponse.json() : await secondResponse.json();
    expect(failure.code).toBe('website_hosting_capacity_reached');
  });

  it('applies an effective downgrade by keeping selected sites and pausing only excess sites', async () => {
    mocks.website.findFirst.mockResolvedValueOnce({ ...ownerWebsite, status: 'draft', revision: 2, currentVersion: 2 })
      .mockResolvedValueOnce(null);
    const siteList = [
      { id: 'old-site', publishedDeploymentId: 'old-deployment', deployments: [{ id: 'old-deployment', publishedAt: new Date('2026-01-01T00:00:00Z') }] },
      { id: 'selected-site', publishedDeploymentId: 'selected-deployment', deployments: [{ id: 'selected-deployment', publishedAt: new Date('2026-02-01T00:00:00Z') }] },
      { id: 'new-site', publishedDeploymentId: 'new-deployment', deployments: [{ id: 'new-deployment', publishedAt: new Date('2026-03-01T00:00:00Z') }] },
    ];
    const websiteUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const deploymentUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const accountUpdate = vi.fn();
    const notificationCreate = vi.fn();
    mocks.transaction.mockImplementationOnce(async (callback: (tx: any) => Promise<any>) => callback({
      $queryRaw: vi.fn().mockResolvedValue([]),
      websiteHostingAccount: {
        findUnique: vi.fn().mockResolvedValue(activeHostingAccount({
          scheduledTier: 'SITES_1',
          scheduledSiteLimit: 1,
          scheduledEffectiveAt: new Date(Date.now() - 60_000),
          scheduledKeptWebsiteIds: ['selected-site'],
        })),
        update: accountUpdate,
      },
      website: {
        findMany: vi.fn().mockResolvedValue(siteList),
        updateMany: websiteUpdateMany,
        count: vi.fn().mockResolvedValue(1),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      websiteDeployment: { updateMany: deploymentUpdateMany },
      websiteDomain: mocks.websiteDomain,
      notification: { create: notificationCreate },
    }));

    const response = await publishWebsite(request('https://mento.test/api/websites/site-1/publish', { version: 2, revision: 2 }), { params: Promise.resolve({ websiteId: 'site-1' }) });

    expect(response.status).toBe(409);
    expect(websiteUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: ['old-site', 'new-site'] } }),
    }));
    expect(deploymentUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ websiteId: { in: ['old-site', 'new-site'] } }),
    }));
    expect(accountUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ siteLimit: 1, scheduledTier: null, scheduledEffectiveAt: null }),
    }));
    expect(notificationCreate).not.toHaveBeenCalled();
  });

  it('uses the oldest publications as the fallback and notifies when a due downgrade has no selection', async () => {
    mocks.website.findFirst.mockResolvedValueOnce({ ...ownerWebsite, status: 'draft', revision: 2, currentVersion: 2 })
      .mockResolvedValueOnce(null);
    const siteList = [
      { id: 'old-site', publishedDeploymentId: 'old-deployment', deployments: [{ id: 'old-deployment', publishedAt: new Date('2026-01-01T00:00:00Z') }] },
      { id: 'new-site', publishedDeploymentId: 'new-deployment', deployments: [{ id: 'new-deployment', publishedAt: new Date('2026-03-01T00:00:00Z') }] },
    ];
    const websiteUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const notificationCreate = vi.fn();
    mocks.transaction.mockImplementationOnce(async (callback: (tx: any) => Promise<any>) => callback({
      $queryRaw: vi.fn().mockResolvedValue([]),
      websiteHostingAccount: {
        findUnique: vi.fn().mockResolvedValue(activeHostingAccount({
          scheduledTier: 'SITES_1',
          scheduledSiteLimit: 1,
          scheduledEffectiveAt: new Date(Date.now() - 60_000),
          scheduledKeptWebsiteIds: null,
        })),
        update: vi.fn(),
      },
      website: {
        findMany: vi.fn().mockResolvedValue(siteList),
        updateMany: websiteUpdateMany,
        count: vi.fn().mockResolvedValue(1),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      websiteDeployment: { updateMany: vi.fn() },
      websiteDomain: mocks.websiteDomain,
      notification: { create: notificationCreate },
    }));

    await publishWebsite(request('https://mento.test/api/websites/site-1/publish', { version: 2, revision: 2 }), { params: Promise.resolve({ websiteId: 'site-1' }) });

    expect(websiteUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: ['new-site'] } }),
    }));
    expect(notificationCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ category: 'BILLING', externalId: expect.stringContaining('website-hosting-downgrade:') }),
    }));
  });

  it('rejects publishing when another website owns the canonical hostname slug', async () => {
    mocks.website.findFirst.mockResolvedValueOnce({ ...ownerWebsite, status: 'draft', revision: 2, currentVersion: 2 })
      .mockResolvedValueOnce({ id: 'other-site' });

    const response = await publishWebsite(request('https://mento.test/api/websites/site-1/publish', { version: 2, revision: 2 }), { params: Promise.resolve({ websiteId: 'site-1' }) });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe('website_slug_conflict');
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.websiteDeployment.create).not.toHaveBeenCalled();
  });

  it('returns a slug conflict when a concurrent publish wins the unique-slug race', async () => {
    mocks.website.findFirst.mockResolvedValueOnce({ ...ownerWebsite, status: 'draft', revision: 2, currentVersion: 2 })
      .mockResolvedValueOnce(null);
    mocks.transaction.mockRejectedValueOnce({ code: 'P2002', meta: { target: ['slug'] } });

    const response = await publishWebsite(request('https://mento.test/api/websites/site-1/publish', { version: 2, revision: 2 }), { params: Promise.resolve({ websiteId: 'site-1' }) });

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('website_slug_conflict');
  });

  it('rejects publishing a title that cannot produce a canonical slug', async () => {
    mocks.website.findFirst.mockResolvedValueOnce({ ...ownerWebsite, title: '東京', status: 'draft', revision: 2, currentVersion: 2 });

    const response = await publishWebsite(request('https://mento.test/api/websites/site-1/publish', { version: 2, revision: 2 }), { params: Promise.resolve({ websiteId: 'site-1' }) });

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('invalid_website_slug');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('serves a published website from the public hostname using the selected deployment', async () => {
    mocks.websiteDeployment.findMany.mockResolvedValueOnce([{
      id: 'deployment-1',
      websiteId: 'site-1',
      version: 2,
      hostname: 'bella-restaurant.mento.site',
      status: 'published',
      website: {
        ...ownerWebsite,
        id: 'site-1',
        status: 'published',
        deletedAt: null,
        publishedVersion: 2,
        publishedDeploymentId: 'deployment-1',
      },
    }]);
    mocks.websiteVersion.findFirst.mockResolvedValueOnce({ content });

    const response = await publicWebsite(new Request('https://bella-restaurant.mento.site', { headers: { host: 'bella-restaurant.mento.site' } }));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(mocks.websiteDeployment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        hostname: 'bella-restaurant.mento.site',
        status: 'published',
        website: { is: { status: 'published', deletedAt: null } },
      },
    }));
    expect(mocks.websiteVersion.findFirst).toHaveBeenCalledWith({
      where: { websiteId: 'site-1', version: 2 },
      select: { content: true },
    });
    expect(body).toContain('<title>Bella Restaurant</title>');
    expect(body).toContain('Taste the coast');
  });

  it('keeps the owner-selected site online when an account downgrade takes effect', async () => {
    const effectiveAt = new Date(Date.now() - 60_000);
    mocks.websiteDeployment.findMany.mockResolvedValueOnce([{
      id: 'selected-deployment',
      websiteId: 'selected-site',
      version: 1,
      hostname: 'selected-site.mento.site',
      status: 'published',
      website: {
        ...ownerWebsite,
        id: 'selected-site',
        status: 'published',
        deletedAt: null,
        publishedVersion: 1,
        publishedDeploymentId: 'selected-deployment',
      },
    }]);
    mocks.websiteVersion.findFirst.mockResolvedValueOnce({ content });
    mocks.website.findUnique.mockResolvedValueOnce({
      userId: 'user-1',
      user: {
        websiteHostingAccount: activeHostingAccount({
          tier: 'SITES_3',
          siteLimit: 3,
          scheduledTier: 'SITES_1',
          scheduledSiteLimit: 1,
          scheduledEffectiveAt: effectiveAt,
          scheduledKeptWebsiteIds: ['selected-site'],
        }),
      },
    });
    mocks.website.findMany.mockResolvedValueOnce([
      { id: 'old-site', publishedDeploymentId: 'old-deployment', deployments: [{ id: 'old-deployment', publishedAt: new Date('2026-01-01T00:00:00Z') }] },
      { id: 'selected-site', publishedDeploymentId: 'selected-deployment', deployments: [{ id: 'selected-deployment', publishedAt: new Date('2026-03-01T00:00:00Z') }] },
    ]);

    const response = await publicWebsite(new Request('https://selected-site.mento.site', { headers: { host: 'selected-site.mento.site' } }));

    expect(response.status).toBe(200);
  });

  it('does not serve an excess site after a hosting downgrade takes effect', async () => {
    mocks.websiteDeployment.findMany.mockResolvedValueOnce([{
      id: 'old-deployment',
      websiteId: 'old-site',
      version: 1,
      hostname: 'old-site.mento.site',
      status: 'published',
      website: {
        ...ownerWebsite,
        id: 'old-site',
        status: 'published',
        deletedAt: null,
        publishedVersion: 1,
        publishedDeploymentId: 'old-deployment',
      },
    }]);
    mocks.websiteVersion.findFirst.mockResolvedValueOnce({ content });
    mocks.website.findUnique.mockResolvedValueOnce({
      userId: 'user-1',
      user: {
        websiteHostingAccount: activeHostingAccount({
          tier: 'SITES_3',
          siteLimit: 3,
          scheduledTier: 'SITES_1',
          scheduledSiteLimit: 1,
          scheduledEffectiveAt: new Date(Date.now() - 60_000),
          scheduledKeptWebsiteIds: ['selected-site'],
        }),
      },
    });
    mocks.website.findMany.mockResolvedValueOnce([
      { id: 'old-site', publishedDeploymentId: 'old-deployment', deployments: [{ id: 'old-deployment', publishedAt: new Date('2026-01-01T00:00:00Z') }] },
      { id: 'selected-site', publishedDeploymentId: 'selected-deployment', deployments: [{ id: 'selected-deployment', publishedAt: new Date('2026-03-01T00:00:00Z') }] },
    ]);

    const response = await publicWebsite(new Request('https://old-site.mento.site', { headers: { host: 'old-site.mento.site' } }));

    expect(response.status).toBe(404);
  });

  it('keeps a newly published unpaid site online during the configured grace period', async () => {
    const recentlyPublishedAt = new Date(Date.now() - 60 * 1000);
    const deployment = {
      id: 'deployment-1',
      websiteId: 'site-1',
      version: 2,
      hostname: 'bella-restaurant.mento.site',
      status: 'published',
      website: {
        ...ownerWebsite,
        id: 'site-1',
        status: 'published',
        deletedAt: null,
        publishedVersion: 2,
        publishedDeploymentId: 'deployment-1',
      },
    };
    mocks.websiteDeployment.findMany.mockResolvedValueOnce([deployment]);
    mocks.websiteVersion.findFirst.mockResolvedValueOnce({ content });
    mocks.websiteDeployment.findFirst.mockResolvedValueOnce({ publishedAt: recentlyPublishedAt, createdAt: recentlyPublishedAt });
    mocks.paymentTransaction.findFirst.mockResolvedValueOnce(null);

    const response = await publicWebsite(new Request('https://bella-restaurant.mento.site', { headers: { host: 'bella-restaurant.mento.site' } }));

    expect(response.status).toBe(200);
  });

  it('suspends an unpaid site after grace without serving a stale deployment', async () => {
    const oldPublishedAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    const deployment = {
      id: 'deployment-1',
      websiteId: 'site-1',
      version: 2,
      hostname: 'bella-restaurant.mento.site',
      status: 'published',
      website: {
        ...ownerWebsite,
        id: 'site-1',
        status: 'published',
        deletedAt: null,
        publishedVersion: 2,
        publishedDeploymentId: 'deployment-1',
      },
    };
    mocks.websiteDeployment.findMany.mockResolvedValueOnce([deployment]);
    mocks.websiteVersion.findFirst.mockResolvedValueOnce({ content });
    mocks.websiteDeployment.findFirst.mockResolvedValueOnce({ publishedAt: oldPublishedAt, createdAt: oldPublishedAt });
    mocks.paymentTransaction.findFirst.mockResolvedValueOnce(null);

    const response = await publicWebsite(new Request('https://bella-restaurant.mento.site', { headers: { host: 'bella-restaurant.mento.site' } }));

    expect(response.status).toBe(404);
  });

  it('ignores x-forwarded-host and only resolves the exact validated Host', async () => {
    mocks.websiteDeployment.findMany.mockResolvedValueOnce([]);
    const response = await publicWebsite(new Request('https://unknown.mento.site', {
      headers: {
        host: 'unknown.mento.site',
        'x-forwarded-host': 'bella-restaurant.mento.site',
      },
    }));

    expect(response.status).toBe(404);
    expect(mocks.websiteDeployment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ hostname: 'unknown.mento.site' }),
    }));
    expect(mocks.website.findFirst).not.toHaveBeenCalled();
  });

  it('rejects hosts outside the canonical Mento Websites domain', async () => {
    const response = await publicWebsite(new Request('https://bella-restaurant.mento.site', {
      headers: {
        host: 'bella-restaurant.attacker.example',
        'x-forwarded-host': 'bella-restaurant.mento.site',
      },
    }));

    expect(response.status).toBe(404);
    expect(mocks.websiteDeployment.findMany).not.toHaveBeenCalled();
  });

  it('does not serve a deployment that is not the website selected publication', async () => {
    mocks.websiteDeployment.findMany.mockResolvedValueOnce([{
      id: 'deployment-1',
      websiteId: 'site-1',
      version: 2,
      hostname: 'bella-restaurant.mento.site',
      status: 'published',
      website: {
        ...ownerWebsite,
        id: 'site-1',
        status: 'published',
        deletedAt: null,
        publishedVersion: 2,
        publishedDeploymentId: 'different-deployment',
      },
    }]);

    const response = await publicWebsite(new Request('https://bella-restaurant.mento.site', { headers: { host: 'bella-restaurant.mento.site' } }));

    expect(response.status).toBe(404);
    expect(mocks.websiteVersion.findFirst).not.toHaveBeenCalled();
    expect(mocks.paymentTransaction.findFirst).not.toHaveBeenCalled();
  });

  it('does not serve a selected deployment whose version is no longer current', async () => {
    mocks.websiteDeployment.findMany.mockResolvedValueOnce([{
      id: 'deployment-1',
      websiteId: 'site-1',
      version: 1,
      hostname: 'bella-restaurant.mento.site',
      status: 'published',
      website: {
        ...ownerWebsite,
        id: 'site-1',
        status: 'published',
        deletedAt: null,
        publishedVersion: 2,
        publishedDeploymentId: 'deployment-1',
      },
    }]);

    const response = await publicWebsite(new Request('https://bella-restaurant.mento.site', { headers: { host: 'bella-restaurant.mento.site' } }));

    expect(response.status).toBe(404);
    expect(mocks.websiteVersion.findFirst).not.toHaveBeenCalled();
  });

  it('does not serve an ambiguous hostname mapped to multiple selected deployments', async () => {
    mocks.websiteDeployment.findMany.mockResolvedValueOnce([
      {
        id: 'deployment-1',
        websiteId: 'site-1',
        version: 2,
        hostname: 'bella-restaurant.mento.site',
        status: 'published',
        website: {
          ...ownerWebsite,
          id: 'site-1',
          status: 'published',
          deletedAt: null,
          publishedVersion: 2,
          publishedDeploymentId: 'deployment-1',
        },
      },
      {
        id: 'deployment-2',
        websiteId: 'site-2',
        version: 1,
        hostname: 'bella-restaurant.mento.site',
        status: 'published',
        website: {
          ...ownerWebsite,
          id: 'site-2',
          status: 'published',
          deletedAt: null,
          publishedVersion: 1,
          publishedDeploymentId: 'deployment-2',
        },
      },
    ]);

    const response = await publicWebsite(new Request('https://bella-restaurant.mento.site', { headers: { host: 'bella-restaurant.mento.site' } }));

    expect(response.status).toBe(404);
    expect(mocks.websiteVersion.findFirst).not.toHaveBeenCalled();
  });

  it('does not edit a website that is not owned by the authenticated user', async () => {
    mocks.website.findFirst.mockResolvedValueOnce(null);
    const response = await editWebsite(request('https://mento.test/api/websites/other-site/edit', {
      prompt: 'Change the theme',
      requestId: 'website-edit-1234',
      revision: 0,
    }), { params: Promise.resolve({ websiteId: 'other-site' }) });

    expect(response.status).toBe(404);
    expect(mocks.executeAIRequest).not.toHaveBeenCalled();
    expect(mocks.askGemini).not.toHaveBeenCalled();
    expect(mocks.website.findFirst).toHaveBeenCalledWith({ where: { id: 'other-site', userId: 'user-1' } });
  });

  it('rejects stale manual edits without invoking Gemini', async () => {
    mocks.website.findFirst.mockResolvedValue(ownerWebsite);
    mocks.website.updateMany.mockResolvedValue({ count: 0 });
    const response = await updateWebsite(request('https://mento.test/api/websites/site-1', {
      type: 'restaurant',
      revision: 1,
      content,
    }, 'PATCH'), { params: Promise.resolve({ websiteId: 'site-1' }) });

    expect(response.status).toBe(409);
    expect(mocks.website.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'site-1', userId: 'user-1', deletedAt: null, revision: 1, type: 'restaurant' },
    }));
    expect(mocks.executeAIRequest).not.toHaveBeenCalled();
  });

  it('stores one immutable ai_edit version for one natural-language request', async () => {
    const websiteWithAssets = {
      ...ownerWebsite,
      content: {
        ...content,
        type: 'restaurant',
        designPreset: 'creative-portfolio',
        pages: [{
          id: 'home',
          title: 'Home',
          slug: 'home',
          sections: [{ id: 'hero-section', type: 'hero', title: 'Taste the coast', body: 'Fresh seafood and Swahili favorites.', imageSlotId: 'hero-image' }],
        }],
        menuCategories: [{
          id: 'mains',
          name: 'Main Dishes',
          items: [{ id: 'biryani', name: 'Chicken Biryani', description: 'Spiced rice with chicken', price: '650', currency: 'KSh', imageUrl: null, imageSlotId: null, available: true }],
        }],
        imageSlots: [{ id: 'hero-image', role: 'hero', targetId: 'hero-section', query: 'coastal restaurant table', alt: 'A restaurant table by the coast', assetId: 'asset-image-1' }],
        socialLinks: { instagram: 'https://instagram.com/bella', facebook: '', tiktok: '' },
        seo: { title: 'Bella Restaurant', description: 'Swahili dishes by the coast.' },
      },
    };
    mocks.website.findFirst.mockResolvedValueOnce(websiteWithAssets);
    mocks.askGemini
      .mockResolvedValueOnce('invalid JSON')
      .mockResolvedValueOnce(JSON.stringify(websiteWithAssets.content));
    const editedWebsite = { ...ownerWebsite, revision: 3, currentVersion: 2 };
    const version = { id: 'version-2', version: 2, source: 'ai_edit', summary: 'Make it more premium' };
    const tx = {
      website: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirst: vi.fn().mockResolvedValue(editedWebsite),
      },
      websiteVersion: { create: vi.fn().mockResolvedValue(version) },
    };
    mocks.transaction.mockImplementationOnce((callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx));

    const response = await editWebsite(request('https://mento.test/api/websites/site-1/edit', {
      prompt: 'Make the homepage more premium.',
      requestId: 'website-edit-success-1234',
      revision: 2,
    }), { params: Promise.resolve({ websiteId: 'site-1' }) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.askGemini).toHaveBeenCalledTimes(2);
    expect(mocks.askGemini.mock.calls.map((call) => call[5])).toEqual([
      { responseMimeType: 'application/json', maxOutputTokens: 8192 },
      { responseMimeType: 'application/json', maxOutputTokens: 8192 },
    ]);
    const systemPrompt = mocks.askGemini.mock.calls[0][0].find((message) => message.role === 'system')?.parts[0]?.text;
    const userPrompt = mocks.askGemini.mock.calls[0][0].find((message) => message.role === 'user')?.parts[0]?.text;
    expect(systemPrompt).toContain('"imageSlots"');
    expect(systemPrompt).toContain('"socialLinks"');
    expect(systemPrompt).toContain('"seo"');
    expect(userPrompt).toContain('"assetId":"asset-image-1"');
    expect(body.version).toEqual(version);
    expect(tx.website.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        content: expect.objectContaining({
          designPreset: 'creative-portfolio',
          pages: expect.arrayContaining([
            expect.objectContaining({
              id: 'home',
              sections: expect.arrayContaining([expect.objectContaining({ id: 'hero-section', imageSlotId: 'hero-image' })]),
            }),
          ]),
          imageSlots: [expect.objectContaining({ id: 'hero-image', assetId: 'asset-image-1' })],
          socialLinks: { instagram: 'https://instagram.com/bella', facebook: '', tiktok: '' },
          seo: { title: 'Bella Restaurant', description: 'Swahili dishes by the coast.' },
        }),
      }),
    }));
    expect(mocks.executeAIRequest).toHaveBeenCalledWith(expect.objectContaining({
      feature: 'website',
      amount: 1,
      metadata: expect.objectContaining({ operationType: 'website.ai_edit', websiteId: 'site-1' }),
    }));
    expect(tx.websiteVersion.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ version: 2, source: 'ai_edit' }) }));
  });

  it('blocks a 51st successful AI edit and counts only completed AI edit usage', async () => {
    mocks.website.findFirst.mockResolvedValueOnce(ownerWebsite);
    mocks.usageLog.count.mockResolvedValue(50);

    const response = await editWebsite(request('https://mento.test/api/websites/site-1/edit', {
      prompt: 'Make the homepage more premium.',
      requestId: 'website-edit-over-limit',
      revision: 2,
    }), { params: Promise.resolve({ websiteId: 'site-1' }) });

    expect(response.status).toBe(403);
    expect(mocks.executeAIRequest).not.toHaveBeenCalled();
    expect(mocks.usageLog.count).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ feature: 'website', success: true, metadata: { path: ['operationType'], equals: 'website.ai_edit' } }),
    }));
    expect(mocks.securityEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'WEBSITE_POLICY_DENIED', details: { mode: 'edit', reason: 'edit_limit' } }) }));
  });

  it('restores a prior version by appending a restore snapshot without calling Gemini', async () => {
    mocks.website.findFirst.mockResolvedValueOnce({ id: 'site-1', revision: 2, type: 'restaurant' });
    mocks.websiteVersion.findFirst.mockResolvedValueOnce({ id: 'version-1', websiteId: 'site-1', version: 1, content });
    const restoredWebsite = { ...ownerWebsite, revision: 3, currentVersion: 2 };
    const restoreSnapshot = { id: 'version-2', version: 2, source: 'restore', summary: 'Restored version 1' };
    const tx = {
      website: { update: vi.fn().mockResolvedValue(restoredWebsite) },
      websiteVersion: { create: vi.fn().mockResolvedValue(restoreSnapshot) },
    };
    mocks.transaction.mockImplementationOnce((callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx));

    const response = await restoreWebsite(request('https://mento.test/api/websites/site-1/restore', { version: 1, revision: 2 }), {
      params: Promise.resolve({ websiteId: 'site-1' }),
    });

    expect(response.status).toBe(200);
    expect(tx.websiteVersion.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ version: 2, source: 'restore' }) }));
    expect(mocks.executeAIRequest).not.toHaveBeenCalled();
    expect(mocks.askGemini).not.toHaveBeenCalled();
  });
});