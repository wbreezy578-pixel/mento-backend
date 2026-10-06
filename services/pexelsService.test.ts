import assert from 'node:assert/strict';
import test from 'node:test';
import { createPexelsImageSearch } from './pexelsService';

const validPhoto = {
  id: 123,
  width: 1600,
  height: 900,
  url: 'https://www.pexels.com/photo/restaurant-123/',
  photographer: 'A. Photographer',
  photographer_url: 'https://www.pexels.com/@aphotographer',
  avg_color: '#aabbcc',
  alt: 'Seafood on a restaurant table',
  src: {
    landscape: 'https://images.pexels.com/photos/123/photo.jpeg?auto=compress',
    medium: 'https://images.pexels.com/photos/123/photo-medium.jpeg',
  },
};

test('searches Pexels on the server, maps attribution, and caches repeated queries', async () => {
  let calls = 0;
  const client = createPexelsImageSearch({
    apiKey: 'server-key',
    fetchImpl: async (input, init) => {
      calls += 1;
      assert.match(String(input), /query=seafood\+restaurant/);
      assert.equal(new Headers(init?.headers).get('authorization'), 'server-key');
      return new Response(JSON.stringify({ photos: [validPhoto] }), { status: 200 });
    },
    now: () => 1000,
  });

  const first = await client.search('seafood restaurant');
  const second = await client.search(' Seafood   Restaurant ');
  assert.equal(calls, 1);
  assert.deepEqual(second[0], first[0]);
  assert.equal(first[0].providerAssetId, '123');
  assert.equal(first[0].creatorName, 'A. Photographer');
  assert.equal(first[0].sourcePageUrl, validPhoto.url);
});

test('rejects untrusted image and attribution hosts from provider responses', async () => {
  const client = createPexelsImageSearch({
    apiKey: 'server-key',
    fetchImpl: async () => new Response(JSON.stringify({ photos: [{
      ...validPhoto,
      src: { landscape: 'https://attacker.example/image.jpg', medium: validPhoto.src.medium },
    }] }), { status: 200 }),
  });
  assert.deepEqual(await client.search('seafood'), []);
});

test('fails closed without a server API key and reports provider rate limits', async () => {
  const missingKey = createPexelsImageSearch({ apiKey: '' });
  await assert.rejects(missingKey.search('seafood'), /not configured/);
  const rateLimited = createPexelsImageSearch({ apiKey: 'server-key', fetchImpl: async () => new Response('', { status: 429 }) });
  await assert.rejects(rateLimited.search('seafood'), /rate limited/);
});