import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  websiteDomainFindUnique: vi.fn(),
  websiteDeploymentFindFirst: vi.fn(),
  getWebsiteHostingState: vi.fn(),
  verifyWebsiteRouterRequest: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('../../../../../lib/prisma', () => ({
  prisma: {
    websiteDomain: { findUnique: mocks.websiteDomainFindUnique },
    websiteDeployment: { findFirst: mocks.websiteDeploymentFindFirst },
  },
}));
vi.mock('../../../../../lib/websiteRouterAuth', () => ({
  verifyWebsiteRouterRequest: mocks.verifyWebsiteRouterRequest,
}));
vi.mock('../../../../../services/websiteBillingService', () => ({
  getWebsiteHostingState: mocks.getWebsiteHostingState,
}));
vi.mock('../../../../../lib/logger', () => ({
  default: { error: mocks.loggerError, warn: vi.fn(), info: vi.fn() },
}));

import { GET } from './route';

const hostname = 'web-denton-waterhub.trymentoapp.com';
const domain = {
  status: 'active',
  website: {
    id: 'website-1',
    status: 'published',
    deletedAt: null,
    publishedVersion: 2,
    publishedDeploymentId: 'deployment-2',
  },
};
const deployment = {
  id: 'deployment-2',
  websiteId: 'website-1',
  r2Prefix: 'websites/website-1/deployments/deployment-2',
  manifestKey: 'websites/website-1/deployments/deployment-2/manifest.json',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('WEBSITE_ROUTER_SHARED_SECRET', 'a sufficiently long staging router secret');
  mocks.verifyWebsiteRouterRequest.mockResolvedValue(true);
  mocks.websiteDomainFindUnique.mockResolvedValue(domain);
  mocks.websiteDeploymentFindFirst.mockResolvedValue(deployment);
  mocks.getWebsiteHostingState.mockResolvedValue({ status: 'active', graceEndsAt: null, lastChargeDate: null });
});
afterEach(() => vi.unstubAllEnvs());

describe('Websites Worker hostname resolver', () => {
  it('returns only the current deployment reference for an active owned hostname', async () => {
    const response = await GET(new Request(`https://mento.test/api/websites/public/resolve?hostname=${hostname}`));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual({
      websiteId: 'website-1',
      deploymentId: 'deployment-2',
      manifestKey: deployment.manifestKey,
    });
    expect(mocks.websiteDeploymentFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 'deployment-2',
        websiteId: 'website-1',
        version: 2,
        status: 'published',
      },
    }));
  });

  it('requires Worker authentication and never resolves the Mento app hostname', async () => {
    mocks.verifyWebsiteRouterRequest.mockResolvedValue(false);
    const unauthorized = await GET(new Request(`https://mento.test/api/websites/public/resolve?hostname=${hostname}`));
    expect(unauthorized.status).toBe(401);
    expect(mocks.websiteDomainFindUnique).not.toHaveBeenCalled();

    mocks.verifyWebsiteRouterRequest.mockResolvedValue(true);
    const appHost = await GET(new Request('https://mento.test/api/websites/public/resolve?hostname=auth.trymentoapp.com'));
    expect(appHost.status).toBe(404);
    expect(mocks.websiteDomainFindUnique).not.toHaveBeenCalled();
  });

  it('fails closed for disabled, deleted, superseded, or suspended websites', async () => {
    mocks.websiteDomainFindUnique.mockResolvedValueOnce({ ...domain, status: 'disabled' });
    expect((await GET(new Request(`https://mento.test/api/websites/public/resolve?hostname=${hostname}`))).status).toBe(404);

    mocks.websiteDomainFindUnique.mockResolvedValueOnce({ ...domain, website: { ...domain.website, deletedAt: new Date() } });
    expect((await GET(new Request(`https://mento.test/api/websites/public/resolve?hostname=${hostname}`))).status).toBe(404);

    mocks.getWebsiteHostingState.mockResolvedValueOnce({ status: 'suspended', graceEndsAt: null, lastChargeDate: null });
    expect((await GET(new Request(`https://mento.test/api/websites/public/resolve?hostname=${hostname}`))).status).toBe(404);
  });
});
