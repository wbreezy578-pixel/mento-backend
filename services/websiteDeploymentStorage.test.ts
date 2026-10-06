import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebsiteHostname, isWebsiteHostname, uploadWebsiteDeployment, WebsiteDeploymentConfigurationError } from './websiteDeploymentStorage';

const content = {
  type: 'business',
  title: 'Test Site',
  description: 'Test description',
  theme: { primaryColor: '#123456' },
  pages: [{ title: 'Home', slug: 'home', sections: [{ type: 'hero', title: 'Hello', body: 'World' }] }],
  menuCategories: [],
  imageSlots: [],
  galleryImageUrls: [],
  contact: { address: '', phone: '', whatsappNumber: '' },
};

function setStagingEnvironment() {
  vi.stubEnv('WEBSITE_DEPLOYMENTS_ENABLED', 'true');
  vi.stubEnv('WEBSITE_DEPLOYMENT_STAGE', 'staging');
  vi.stubEnv('WEBSITE_DEPLOYMENTS_BUCKET', 'mento-websites-staging-tests');
  vi.stubEnv('CLOUDFLARE_R2_ACCOUNT_ID', 'a'.repeat(32));
  vi.stubEnv('CLOUDFLARE_R2_ACCESS_KEY_ID', 'staging-access-key');
  vi.stubEnv('CLOUDFLARE_R2_SECRET_ACCESS_KEY', 'staging-secret-key');
}

function setProductionEnvironment() {
  vi.stubEnv('WEBSITE_DEPLOYMENTS_ENABLED', 'true');
  vi.stubEnv('WEBSITE_DEPLOYMENT_STAGE', 'production');
  vi.stubEnv('WEBSITE_DEPLOYMENTS_BUCKET', 'mento-websites-production');
  vi.stubEnv('CLOUDFLARE_R2_ACCOUNT_ID', 'b'.repeat(32));
  vi.stubEnv('CLOUDFLARE_R2_ACCESS_KEY_ID', 'production-access-key');
  vi.stubEnv('CLOUDFLARE_R2_SECRET_ACCESS_KEY', 'production-secret-key');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('website deployment storage configuration', () => {
  it('uses reserved first-level web hostnames and rejects the app namespace', () => {
    expect(createWebsiteHostname('denton-waterhub')).toBe('web-denton-waterhub.trymentoapp.com');
    expect(isWebsiteHostname('web-denton-waterhub.trymentoapp.com')).toBe(true);
    expect(isWebsiteHostname('auth.trymentoapp.com')).toBe(false);
    expect(isWebsiteHostname('x.web-denton-waterhub.trymentoapp.com')).toBe(false);
    expect(() => createWebsiteHostname('東京')).toThrow(/cannot be used/);
  });

  it('refuses disabled or invalid deployment configuration', async () => {
    await expect(uploadWebsiteDeployment({ websiteId: 'website-1', version: 1, content }))
      .rejects.toBeInstanceOf(WebsiteDeploymentConfigurationError);

    setStagingEnvironment();
    vi.stubEnv('WEBSITE_DEPLOYMENT_STAGE', 'test');
    await expect(uploadWebsiteDeployment({ websiteId: 'website-1', version: 1, content }))
      .rejects.toThrow(/must be staging or production/);

    setProductionEnvironment();
    vi.stubEnv('WEBSITE_DEPLOYMENTS_BUCKET', 'mento-websites-staging');
    await expect(uploadWebsiteDeployment({ websiteId: 'website-1', version: 1, content }))
      .rejects.toThrow(/must use the mento-websites-production name/);
  });

  it('uploads an immutable prefix and writes its manifest last', async () => {
    setStagingEnvironment();
    const calls: Array<{ url: string; body: string; headers: Headers }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: init?.body instanceof Uint8Array
          ? new TextDecoder().decode(init.body)
          : String(init?.body ?? ''),
        headers: new Headers(init?.headers),
      });
      return new Response(null, { status: 200 });
    }));

    const deployment = await uploadWebsiteDeployment({
      websiteId: 'website-1',
      version: 4,
      deploymentId: 'deployment-4',
      content,
    });

    expect(deployment.r2Prefix).toBe('websites/website-1/deployments/deployment-4');
    expect(deployment.manifestKey).toBe(`${deployment.r2Prefix}/manifest.json`);
    expect(deployment.artifactHash).toMatch(/^[a-f0-9]{64}$/);
    expect(deployment.artifactSize).toBeGreaterThan(0);
    expect(calls.at(-1)?.url).toContain('/mento-websites-staging-tests/websites/website-1/deployments/deployment-4/manifest.json');
    expect(JSON.parse(calls.at(-1)!.body)).toMatchObject({ websiteId: 'website-1', deploymentId: 'deployment-4', version: 4 });
    expect(calls.every((call) => call.headers.get('authorization')?.startsWith('AWS4-HMAC-SHA256 '))).toBe(true);
    expect(Object.keys(deployment.manifest)).toContain('index.html');
  });

  it('uploads production deployments only to the dedicated production bucket', async () => {
    setProductionEnvironment();
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(null, { status: 200 });
    }));

    await uploadWebsiteDeployment({
      websiteId: 'website-1',
      version: 1,
      deploymentId: 'production-deployment',
      content,
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((url) => url.includes('/mento-websites-production/'))).toBe(true);
    expect(calls.every((url) => !url.includes('/mento-websites-staging'))).toBe(true);
  });
});
