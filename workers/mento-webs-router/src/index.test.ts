import { createHash, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './index';

const hostname = 'web-denton-waterhub.trymentoapp.com';
const secret = 'staging-router-test-secret';
const resolverUrl = 'https://staging-api.invalid/api/websites/public/resolve';

function r2Object(body: string) {
  return { body: new Response(body).body! };
}

function signedResolverResponse(resolution: { websiteId: string; deploymentId: string; manifestKey: string }) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = new URL(String(input));
    const timestamp = new Headers(init?.headers).get('x-mento-timestamp')!;
    const nonce = new Headers(init?.headers).get('x-mento-nonce')!;
    const signature = new Headers(init?.headers).get('x-mento-signature')!;
    const expected = createHmac('sha256', secret)
      .update([timestamp, nonce, 'GET', `${target.pathname}?hostname=${encodeURIComponent(hostname)}`].join('\n'))
      .digest('hex');
    expect(signature).toBe(expected);
    return Response.json(resolution);
  }));
}

function environment(objects: Record<string, string>) {
  return {
    WEBSITE_DEPLOYMENTS: {
      get: vi.fn(async (key: string) => objects[key] === undefined ? null : r2Object(objects[key])),
    },
    WEBSITE_ROUTER_SHARED_SECRET: secret,
    WEBSITE_RESOLVER_URL: resolverUrl,
    WEBSITE_HOST_DOMAIN: 'trymentoapp.com',
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('Mento Websites Cloudflare Worker', () => {
  it('does not accept the Mento app hostname or other non-Webs hosts', async () => {
    const env = environment({});
    const auth = await worker.fetch(new Request('https://auth.trymentoapp.com/'), env);
    const nonWebPrefix = await worker.fetch(new Request('https://denton-waterhub.trymentoapp.com/'), env);

    expect(auth.status).toBe(404);
    expect(nonWebPrefix.status).toBe(404);
    expect(env.WEBSITE_DEPLOYMENTS.get).not.toHaveBeenCalled();
  });

  it('serves a manifest-listed immutable page only after signed hostname resolution', async () => {
    const html = '<!doctype html><title>Denton Water Hub</title>';
    const css = 'body{color:#123456}';
    const deploymentId = 'deployment-1';
    const websiteId = 'website-1';
    const manifestKey = `websites/${websiteId}/deployments/${deploymentId}/manifest.json`;
    const manifest = {
      schemaVersion: 1,
      websiteId,
      deploymentId,
      version: 3,
      entries: {
        'index.html': {
          key: `websites/${websiteId}/deployments/${deploymentId}/index.html`,
          contentType: 'text/html; charset=utf-8',
          cacheControl: 'no-store',
          sha256: createHash('sha256').update(html).digest('hex'),
        },
        'assets/site.css': {
          key: `websites/${websiteId}/deployments/${deploymentId}/assets/site.css`,
          contentType: 'text/css; charset=utf-8',
          cacheControl: 'public, max-age=31536000, immutable',
          sha256: createHash('sha256').update(css).digest('hex'),
        },
      },
    };
    const env = environment({
      [manifestKey]: JSON.stringify(manifest),
      [`websites/${websiteId}/deployments/${deploymentId}/index.html`]: html,
      [`websites/${websiteId}/deployments/${deploymentId}/assets/site.css`]: css,
    });
    signedResolverResponse({ websiteId, deploymentId, manifestKey });

    const response = await worker.fetch(new Request(`https://${hostname}/`), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("script-src 'none'");
    expect(await response.text()).toBe(html);
    expect(env.WEBSITE_DEPLOYMENTS.get).toHaveBeenCalledTimes(2);
  });

  it('does not serve manifest entries that escape the resolved deployment or fail integrity', async () => {
    const html = '<h1>not the published bytes</h1>';
    const websiteId = 'website-1';
    const deploymentId = 'deployment-1';
    const manifestKey = `websites/${websiteId}/deployments/${deploymentId}/manifest.json`;
    const env = environment({
      [manifestKey]: JSON.stringify({
        schemaVersion: 1,
        websiteId,
        deploymentId,
        version: 1,
        entries: {
          'index.html': {
            key: 'websites/other-site/deployments/other-deployment/index.html',
            contentType: 'text/html; charset=utf-8',
            cacheControl: 'no-store',
            sha256: createHash('sha256').update(html).digest('hex'),
          },
        },
      }),
      'websites/other-site/deployments/other-deployment/index.html': html,
    });
    signedResolverResponse({ websiteId, deploymentId, manifestKey });

    const response = await worker.fetch(new Request(`https://${hostname}/`), env);

    expect(response.status).toBe(404);
    expect(env.WEBSITE_DEPLOYMENTS.get).toHaveBeenCalledTimes(1);
  });

  it('rejects path traversal and non-read methods', async () => {
    const env = environment({});
    const traversal = await worker.fetch(new Request(`https://${hostname}/%252e%252e/private`), env);
    const post = await worker.fetch(new Request(`https://${hostname}/`, { method: 'POST' }), env);

    expect(traversal.status).toBe(400);
    expect(post.status).toBe(405);
    expect(env.WEBSITE_DEPLOYMENTS.get).not.toHaveBeenCalled();
  });
});
