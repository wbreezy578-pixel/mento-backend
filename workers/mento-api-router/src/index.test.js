import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import worker from './index.js';

const greenOrigin = 'https://mento-backend-migration-twmmcrm25a-uk.a.run.app';
const blueOrigin = 'https://mento-backend-blue-twmmcrm25a-uk.a.run.app';
const env = {
  PRODUCTION_API_COLOR: 'green',
  GREEN_API_ORIGIN: greenOrigin,
  GREEN_WEBSITES_API_ORIGIN: 'https://phase6-websites---mento-backend-migration-twmmcrm25a-uk.a.run.app',
  BLUE_API_ORIGIN: blueOrigin,
};
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Mento API Cloudflare router', () => {
  it('keeps the production hostname on Green by default and proxies request details', async () => {
    let forwarded;
    globalThis.fetch = async (request, options) => {
      forwarded = { request, options };
      return new Response('green response', {
        status: 201,
        headers: { 'content-type': 'application/json', 'set-cookie': 'session=opaque' },
      });
    };

    const response = await worker.fetch(new Request('https://api.trymentoapp.com/api/login?source=mobile', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: '{"email":"test@example.invalid"}',
    }), env);

    assert.equal(forwarded.request.url, `${greenOrigin}/api/login?source=mobile`);
    assert.equal(forwarded.request.headers.get('authorization'), 'Bearer test-token');
    assert.equal(forwarded.request.headers.get('x-forwarded-host'), 'api.trymentoapp.com');
    assert.equal(await forwarded.request.text(), '{"email":"test@example.invalid"}');
    assert.equal(forwarded.options.cf.cacheTtl, 0);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('set-cookie'), 'session=opaque');
    assert.equal(await response.text(), 'green response');
  });

  it('routes Websites and hosting billing endpoints to the tagged Green candidate', async () => {
    const paths = [
      '/api/websites',
      '/api/websites/site-1/edit',
      '/api/websites/public/resolve?hostname=web-example.trymentoapp.com',
      '/api/payments/mobile/verify',
      '/api/payments/mobile/google-rtdn',
    ];
    const destinations = [];
    globalThis.fetch = async (request) => {
      destinations.push(request.url);
      return new Response('candidate response');
    };

    for (const path of paths) {
      await worker.fetch(new Request(`https://api.trymentoapp.com${path}`), env);
    }

    assert.deepEqual(destinations, paths.map((path) => (
      `https://phase6-websites---mento-backend-migration-twmmcrm25a-uk.a.run.app${path}`
    )));
  });

  it('keeps non-Website payment routes on the stable Green revision', async () => {
    let destination;
    globalThis.fetch = async (request) => {
      destination = request.url;
      return new Response('stable response');
    };

    await worker.fetch(new Request('https://api.trymentoapp.com/api/payments'), env);

    assert.equal(destination, `${greenOrigin}/api/payments`);
  });

  it('sends the dedicated Blue test hostname to Blue without changing production routing', async () => {
    let destination;
    globalThis.fetch = async (request) => {
      destination = request.url;
      return new Response('blue response');
    };

    const response = await worker.fetch(new Request('https://blue-api.trymentoapp.com/api/live'), env);

    assert.equal(destination, `${blueOrigin}/api/live`);
    assert.equal(await response.text(), 'blue response');
    assert.equal(env.PRODUCTION_API_COLOR, 'green');
  });

  it('keeps Websites paths on the dedicated Blue test hostname routed to Blue', async () => {
    let destination;
    globalThis.fetch = async (request) => {
      destination = request.url;
      return new Response('blue response');
    };

    await worker.fetch(new Request('https://blue-api.trymentoapp.com/api/websites'), env);

    assert.equal(destination, `${blueOrigin}/api/websites`);
  });

  it('fails closed when the Websites candidate origin is invalid', async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response('unexpected');
    };

    const response = await worker.fetch(new Request('https://api.trymentoapp.com/api/websites'), {
      ...env,
      GREEN_WEBSITES_API_ORIGIN: 'http://attacker.example',
    });

    assert.equal(response.status, 503);
    assert.equal(fetchCalled, false);
  });

  it('supports a controlled production cutover to Blue through configuration', async () => {
    let destination;
    globalThis.fetch = async (request) => {
      destination = request.url;
      return new Response('blue response');
    };

    await worker.fetch(new Request('https://api.trymentoapp.com/api/live'), {
      ...env,
      PRODUCTION_API_COLOR: 'blue',
    });

    assert.equal(destination, `${blueOrigin}/api/live`);
  });

  it('exposes a no-store health check for each explicit API hostname', async () => {
    const destinations = [];
    globalThis.fetch = async (request) => {
      destinations.push(request.url);
      return Response.json({ status: 'ok' });
    };

    const green = await worker.fetch(new Request('https://api.trymentoapp.com/__gateway/healthz'), env);
    const blue = await worker.fetch(new Request('https://blue-api.trymentoapp.com/__gateway/healthz'), env);

    assert.equal(green.status, 200);
    assert.equal(green.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await green.json(), { status: 'ok', color: 'green' });
    assert.equal(blue.status, 200);
    assert.deepEqual(await blue.json(), { status: 'ok', color: 'blue' });
    assert.deepEqual(destinations, [
      `${greenOrigin}/api/live`,
      `${blueOrigin}/api/live`,
    ]);
  });

  it('does not route auth.trymentoapp.com or any unconfigured hostname', async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response('unexpected');
    };

    const auth = await worker.fetch(new Request('https://auth.trymentoapp.com/api/login'), env);
    const root = await worker.fetch(new Request('https://trymentoapp.com/api/login'), env);

    assert.equal(auth.status, 404);
    assert.equal(root.status, 404);
    assert.equal(fetchCalled, false);
  });

  it('rejects invalid upstream configuration rather than forwarding elsewhere', async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response('unexpected');
    };

    const response = await worker.fetch(new Request('https://api.trymentoapp.com/api/live'), {
      ...env,
      GREEN_API_ORIGIN: 'https://attacker.example/path',
    });

    assert.equal(response.status, 503);
    assert.equal(fetchCalled, false);
  });

  it('reports an unavailable backend as an unhealthy gateway', async () => {
    globalThis.fetch = async () => new Response('unavailable', { status: 503 });

    const response = await worker.fetch(new Request('https://api.trymentoapp.com/__gateway/healthz'), env);

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: 'unavailable', color: 'green' });
  });
});
