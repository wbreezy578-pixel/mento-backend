const PRODUCTION_HOSTNAME = 'api.trymentoapp.com';
const BLUE_TEST_HOSTNAME = 'blue-api.trymentoapp.com';
const HEALTH_PATH = '/__gateway/healthz';
const WEBSITE_BILLING_PATHS = new Set([
  '/api/payments/mobile/verify',
  '/api/payments/mobile/google-rtdn',
]);

function usesWebsitesCandidate(pathname) {
  return pathname === '/api/websites'
    || pathname.startsWith('/api/websites/')
    || WEBSITE_BILLING_PATHS.has(pathname);
}

function getOrigin(value) {
  if (typeof value !== 'string') return null;

  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || !url.hostname.endsWith('.run.app')
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function resolveUpstream(hostname, env) {
  if (hostname === BLUE_TEST_HOSTNAME) {
    const origin = getOrigin(env.BLUE_API_ORIGIN);
    return { color: 'blue', origin };
  }

  if (hostname !== PRODUCTION_HOSTNAME) return null;

  const color = env.PRODUCTION_API_COLOR || 'green';
  if (color === 'green') {
    const origin = getOrigin(env.GREEN_API_ORIGIN);
    return { color, origin };
  }
  if (color === 'blue') {
    const origin = getOrigin(env.BLUE_API_ORIGIN);
    return { color, origin };
  }
  return { color, origin: null };
}

function buildUpstreamUrl(origin, incomingUrl, pathname) {
  const target = new URL(origin);
  target.pathname = pathname ?? incomingUrl.pathname;
  target.search = incomingUrl.search;
  return target;
}

async function proxy(request, origin, incomingUrl, pathname) {
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.set('x-forwarded-host', incomingUrl.host);

  const methodHasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const upstreamRequest = new Request(buildUpstreamUrl(origin, incomingUrl, pathname), {
    method: request.method,
    headers,
    body: methodHasBody ? request.body : undefined,
    redirect: 'manual',
    duplex: methodHasBody ? 'half' : undefined,
  });

  return fetch(upstreamRequest, {
    cf: { cacheTtl: 0, cacheEverything: false },
  });
}

export default {
  async fetch(request, env) {
    const incomingUrl = new URL(request.url);
    const hostname = incomingUrl.hostname.toLowerCase();
    const upstream = resolveUpstream(hostname, env);
    if (!upstream) return new Response('Not found', { status: 404 });
    if (!upstream.origin) {
      return Response.json(
        { status: 'unavailable' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    let origin = upstream.origin;
    if (hostname === PRODUCTION_HOSTNAME && usesWebsitesCandidate(incomingUrl.pathname)) {
      origin = getOrigin(env.GREEN_WEBSITES_API_ORIGIN);
      if (!origin) {
        return Response.json(
          { status: 'unavailable' },
          { status: 503, headers: { 'Cache-Control': 'no-store' } },
        );
      }
    }

    if (incomingUrl.pathname === HEALTH_PATH) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', {
          status: 405,
          headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' },
        });
      }

      const liveResponse = await proxy(request, upstream.origin, incomingUrl, '/api/live');
      await liveResponse.body?.cancel();
      return Response.json(
        { status: liveResponse.ok ? 'ok' : 'unavailable', color: upstream.color },
        {
          status: liveResponse.ok ? 200 : 503,
          headers: { 'Cache-Control': 'no-store' },
        },
      );
    }

    return proxy(request, origin, incomingUrl);
  },
};
