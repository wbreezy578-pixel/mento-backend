import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureWebsiteWorkerDomain, WebsiteHostnameProvisioningError } from './websiteCloudflareDomainService';

const hostname = 'web-denton-waterhub.trymentoapp.com';
const workerName = 'mento-webs-router-production';

function setProductionEnvironment() {
  vi.stubEnv('WEBSITE_DEPLOYMENTS_ENABLED', 'true');
  vi.stubEnv('WEBSITE_DEPLOYMENT_STAGE', 'production');
  vi.stubEnv('CLOUDFLARE_R2_ACCOUNT_ID', 'a'.repeat(32));
  vi.stubEnv('CLOUDFLARE_WORKERS_API_TOKEN', 'test-api-token');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('website Cloudflare custom domains', () => {
  it('does not provision customer domains outside production', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await ensureWebsiteWorkerDomain(hostname);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects hostnames outside the reserved Webs namespace', async () => {
    setProductionEnvironment();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(ensureWebsiteWorkerDomain('auth.trymentoapp.com'))
      .rejects.toBeInstanceOf(WebsiteHostnameProvisioningError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reattaches no-op for a hostname already connected to the production Websites Worker', async () => {
    setProductionEnvironment();
    const fetchMock = vi.fn(async () => Response.json({
      success: true,
      result: [{ id: 'domain-1', hostname, service: workerName }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    await ensureWebsiteWorkerDomain(hostname);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/workers/domains?hostname=${hostname}`,
    );
  });

  it('attaches an exact hostname to the dedicated Websites Worker when missing', async () => {
    setProductionEnvironment();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ success: true, result: [] }))
      .mockResolvedValueOnce(Response.json({
        success: true,
        result: { id: 'domain-2', hostname, service: workerName },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await ensureWebsiteWorkerDomain(hostname);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string)).toEqual({
      hostname,
      service: workerName,
      zone_name: 'trymentoapp.com',
    });
  });

  it('does not claim a hostname already attached to a different Worker', async () => {
    setProductionEnvironment();
    const fetchMock = vi.fn(async () => Response.json({
      success: true,
      result: [{ id: 'domain-3', hostname, service: 'mento-api-router' }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(ensureWebsiteWorkerDomain(hostname))
      .rejects.toThrow(/already attached to another Worker/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
