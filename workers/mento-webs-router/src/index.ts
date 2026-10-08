interface R2ObjectLike {
  body: ReadableStream<Uint8Array>;
  httpMetadata?: { contentType?: string };
}

interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>;
}

interface RouterEnvironment {
  WEBSITE_DEPLOYMENTS: R2BucketLike;
  WEBSITE_ROUTER_SHARED_SECRET: string;
  WEBSITE_RESOLVER_URL: string;
  WEBSITE_HOST_DOMAIN: string;
}

interface RouteResolution {
  websiteId: string;
  deploymentId: string;
  manifestKey: string;
}

interface ManifestEntry {
  key: string;
  contentType: string;
  cacheControl: string;
  sha256: string;
}

interface DeploymentManifest {
  schemaVersion: number;
  websiteId: string;
  deploymentId: string;
  version: number;
  entries: Record<string, ManifestEntry>;
}

const MAX_MANIFEST_BYTES = 256 * 1024;
const RESERVED_WEB_PREFIX = 'web-';

function unavailable(status = 404): Response {
  return new Response('<!doctype html><title>Website unavailable</title><h1>Website unavailable</h1>', {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

function normalizeCustomerHostname(hostname: string, domain: string): string | null {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, '');
  const suffix = `.${domain.toLowerCase()}`;
  if (!normalized.endsWith(suffix)) return null;
  const label = normalized.slice(0, -suffix.length);
  if (!label.startsWith(RESERVED_WEB_PREFIX) || label.length > 63) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) return null;
  return normalized;
}

function canonicalRequestPath(pathname: string): string | null {
  let decoded: string[];
  try {
    decoded = pathname.split('/').map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
  if (decoded.some((segment) => segment === '.' || segment === '..' || /[\\/\0]/.test(segment))) return null;
  if (decoded.some((segment) => !/^[A-Za-z0-9._~-]*$/.test(segment))) return null;
  const normalized = decoded.filter(Boolean).join('/');
  if (!normalized) return 'index.html';
  return normalized.endsWith('/') ? `${normalized}index.html` : normalized;
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function resolveHostname(hostname: string, env: RouterEnvironment): Promise<RouteResolution | null> {
  const resolverUrl = new URL(env.WEBSITE_RESOLVER_URL);
  if (resolverUrl.protocol !== 'https:' || !env.WEBSITE_ROUTER_SHARED_SECRET) {
    throw new Error('Website resolver is not securely configured.');
  }
  resolverUrl.searchParams.set('hostname', hostname);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();
  const pathname = resolverUrl.pathname;
  const signedPath = `${pathname}?hostname=${encodeURIComponent(hostname)}`;
  const signature = await sign(
    env.WEBSITE_ROUTER_SHARED_SECRET,
    [timestamp, nonce, 'GET', signedPath].join('\n'),
  );
  const response = await fetch(resolverUrl, {
    method: 'GET',
    headers: {
      'x-mento-timestamp': timestamp,
      'x-mento-nonce': nonce,
      'x-mento-signature': signature,
      Accept: 'application/json',
    },
    redirect: 'error',
    cache: 'no-store',
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Website resolver returned ${response.status}.`);
  const result: unknown = await response.json();
  if (!result || typeof result !== 'object') throw new Error('Website resolver returned an invalid response.');
  const candidate = result as Record<string, unknown>;
  if (
    typeof candidate.websiteId !== 'string'
    || typeof candidate.deploymentId !== 'string'
    || typeof candidate.manifestKey !== 'string'
    || !/^[A-Za-z0-9_-]{1,80}$/.test(candidate.websiteId)
    || !/^[A-Za-z0-9_-]{1,80}$/.test(candidate.deploymentId)
    || !/^websites\/[A-Za-z0-9_-]+\/deployments\/[A-Za-z0-9_-]+\/manifest\.json$/.test(candidate.manifestKey)
  ) {
    throw new Error('Website resolver returned an invalid deployment reference.');
  }
  return {
    websiteId: candidate.websiteId,
    deploymentId: candidate.deploymentId,
    manifestKey: candidate.manifestKey,
  };
}

async function readManifest(key: string, env: RouterEnvironment): Promise<DeploymentManifest | null> {
  const object = await env.WEBSITE_DEPLOYMENTS.get(key);
  if (!object) return null;
  const text = await new Response(object.body).text();
  if (new TextEncoder().encode(text).byteLength > MAX_MANIFEST_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const manifest = value as Record<string, unknown>;
  if (
    manifest.schemaVersion !== 1
    || typeof manifest.websiteId !== 'string'
    || typeof manifest.deploymentId !== 'string'
    || !manifest.entries
    || typeof manifest.entries !== 'object'
    || Array.isArray(manifest.entries)
  ) {
    return null;
  }
  return manifest as unknown as DeploymentManifest;
}

function isManifestEntry(value: unknown): value is ManifestEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  const key = typeof entry.key === 'string' ? entry.key : '';
  return typeof entry.key === 'string'
    && /^websites\/[A-Za-z0-9_-]+\/deployments\/[A-Za-z0-9_-]+\/[A-Za-z0-9_./-]+$/.test(key)
    && !key.split('/').some((segment) => segment === '.' || segment === '..')
    && typeof entry.contentType === 'string'
    && ['text/html; charset=utf-8', 'text/css; charset=utf-8'].includes(entry.contentType)
    && typeof entry.cacheControl === 'string'
    && typeof entry.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(entry.sha256);
}

export default {
  async fetch(request: Request, env: RouterEnvironment): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
      }
      const hostname = normalizeCustomerHostname(url.hostname, env.WEBSITE_HOST_DOMAIN || 'trymentoapp.com');
      if (!hostname) return unavailable();
      const path = canonicalRequestPath(url.pathname);
      if (!path) return unavailable(400);

      const resolution = await resolveHostname(hostname, env);
      if (!resolution) return unavailable();
      const manifest = await readManifest(resolution.manifestKey, env);
      if (
        !manifest
        || manifest.websiteId !== resolution.websiteId
        || manifest.deploymentId !== resolution.deploymentId
      ) {
        return unavailable();
      }
      const entryValue = manifest.entries[path];
      if (!isManifestEntry(entryValue)) return unavailable();
      if (!entryValue.key.startsWith(`websites/${resolution.websiteId}/deployments/${resolution.deploymentId}/`)) {
        return unavailable();
      }
      const object = await env.WEBSITE_DEPLOYMENTS.get(entryValue.key);
      if (!object) return unavailable();
      const body = await new Response(object.body).arrayBuffer();
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', body))]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      if (hash !== entryValue.sha256) return unavailable();

      const headers = new Headers({
        'Content-Type': entryValue.contentType,
        'Cache-Control': path.endsWith('.html') ? 'no-store' : 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' https://images.pexels.com https://images.unsplash.com https://*.supabase.co; style-src 'self' 'unsafe-inline'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      });
      if (request.method === 'HEAD') {
        return new Response(null, { headers });
      }
      return new Response(body, { headers });
    } catch (error) {
      console.error('Webs router request failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      return unavailable(503);
    }
  },
};
