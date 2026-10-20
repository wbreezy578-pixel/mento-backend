import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUnsplashImageSearch, createUnsplashPhotoService, UnsplashSearchError, type UnsplashImageSearchResponse, type UnsplashSearchCache } from './unsplashService';

const mocks = vi.hoisted(() => ({ ensureSlidingWindow: vi.fn() }));

vi.mock('../lib/rateLimiter', () => ({ ensureSlidingWindow: mocks.ensureSlidingWindow }));

const photo = {
  id: 'photo-1',
  width: 1800,
  height: 1200,
  urls: {
    raw: 'https://images.unsplash.com/photo-1?auto=format',
    regular: 'https://images.unsplash.com/photo-1?auto=format&w=1080',
    small: 'https://images.unsplash.com/photo-1?auto=format&w=400',
  },
  links: { html: 'https://unsplash.com/photos/photo-1' },
  alt_description: 'Seafood served at a restaurant',
  color: '#aabbcc',
  user: {
    name: 'A. Photographer',
    links: { html: 'https://unsplash.com/@photographer' },
  },
};

function input(overrides: Partial<{ query: string; page: number; perPage: number; orientation: 'landscape' | 'portrait' | 'square' | 'any' }> = {}) {
  return { query: 'seafood restaurant', page: 1, perPage: 12, orientation: 'landscape' as const, ...overrides };
}

function createCache() {
  const values = new Map<string, string>();
  const cache: UnsplashSearchCache = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value, ttl) => {
      expect(ttl).toBe(1800);
      values.set(key, value);
    },
  };
  return { cache, values };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Unsplash image search service', () => {
  beforeEach(() => {
    mocks.ensureSlidingWindow.mockReset().mockResolvedValue({ ok: true });
  });

  it('calls Unsplash server-side, maps safe attribution fields, and reuses normalized cached searches', async () => {
    const { cache } = createCache();
    let calls = 0;
    const search = createUnsplashImageSearch({
      accessKey: 'server-only-access-key',
      cache,
      fetchImpl: async (url, init) => {
        calls += 1;
        const requestUrl = new URL(String(url));
        expect(requestUrl.searchParams.get('query')).toBe('Seafood Restaurant');
        expect(requestUrl.searchParams.get('per_page')).toBe('12');
        expect(requestUrl.searchParams.get('orientation')).toBe('landscape');
        expect(new Headers(init?.headers).get('authorization')).toBe('Client-ID server-only-access-key');
        return new Response(JSON.stringify({ results: [photo], total: 1, total_pages: 1 }), { status: 200 });
      },
    });

    const first = await search(input({ query: '  Seafood   Restaurant  ' }));
    const second = await search(input({ query: 'seafood restaurant' }));
    expect(calls).toBe(1);
    expect(second).toEqual(first);
    expect(mocks.ensureSlidingWindow).toHaveBeenCalledWith(
      'global',
      45,
      3600,
      'rl:webs:unsplash:provider',
      { requireDistributed: true },
    );
    expect(first.results[0]).toEqual({
      id: 'photo-1',
      imageUrl: photo.urls.regular,
      previewUrl: photo.urls.small,
      sourcePageUrl: 'https://unsplash.com/photos/photo-1?utm_source=mento&utm_medium=referral',
      creatorName: 'A. Photographer',
      creatorProfileUrl: 'https://unsplash.com/@photographer?utm_source=mento&utm_medium=referral',
      alt: 'Seafood served at a restaurant',
      width: 1800,
      height: 1200,
      averageColor: '#AABBCC',
    });
    expect(JSON.stringify(first)).not.toContain('server-only-access-key');
  });

  it('uses result-changing pagination and orientation in the shared cache key', async () => {
    const { cache, values } = createCache();
    const search = createUnsplashImageSearch({
      accessKey: 'server-key',
      cache,
      fetchImpl: async () => new Response(JSON.stringify({ results: [], total: 0, total_pages: 0 }), { status: 200 }),
    });
    await search(input());
    await search(input({ page: 2 }));
    await search(input({ perPage: 8 }));
    await search(input({ orientation: 'square' }));
    expect(values.size).toBe(4);
  });

  it('maps square orientation to Unsplash squarish and rejects unsafe response URLs', async () => {
    let requestUrl = '';
    const search = createUnsplashImageSearch({
      accessKey: 'server-key',
      cache: createCache().cache,
      fetchImpl: async (url) => {
        requestUrl = String(url);
        return new Response(JSON.stringify({
          results: [{ ...photo, urls: { ...photo.urls, regular: 'https://attacker.example/image.jpg' } }],
          total: 1,
          total_pages: 1,
        }), { status: 200 });
      },
    });
    const result = await search(input({ orientation: 'square' }));
    expect(new URL(requestUrl).searchParams.get('orientation')).toBe('squarish');
    expect(result.results).toEqual([]);
  });

  it('fails closed when the access key is missing', async () => {
    const search = createUnsplashImageSearch({ accessKey: '', cache: createCache().cache, fetchImpl: vi.fn() });
    await expect(search(input())).rejects.toMatchObject<Partial<UnsplashSearchError>>({ kind: 'not_configured' });
  });

  it('classifies provider rate limits, timeouts, and unavailable responses without exposing provider bodies', async () => {
    const rateLimited = createUnsplashImageSearch({
      accessKey: 'server-key',
      cache: createCache().cache,
      fetchImpl: async () => new Response('private provider details', { status: 429 }),
    });
    await expect(rateLimited(input())).rejects.toMatchObject({ kind: 'rate_limited' });

    const unavailable = createUnsplashImageSearch({
      accessKey: 'server-key',
      cache: createCache().cache,
      fetchImpl: async () => new Response('private provider details', { status: 500 }),
    });
    await expect(unavailable(input())).rejects.toMatchObject({ kind: 'provider_unavailable' });

    const timeout = createUnsplashImageSearch({
      accessKey: 'server-key',
      cache: createCache().cache,
      fetchImpl: async () => { throw new DOMException('sensitive detail', 'TimeoutError'); },
    });
    await expect(timeout(input())).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('returns cached successful empty results as well as non-empty searches', async () => {
    const { cache } = createCache();
    let calls = 0;
    const search = createUnsplashImageSearch({
      accessKey: 'server-key',
      cache,
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ results: [], total: 0, total_pages: 0 }), { status: 200 });
      },
    });
    const first: UnsplashImageSearchResponse = await search(input());
    const second = await search(input());
    expect(first.results).toEqual([]);
    expect(second).toEqual(first);
    expect(calls).toBe(1);
    expect(mocks.ensureSlidingWindow).toHaveBeenCalledTimes(1);
  });

  it('enforces the shared Unsplash demo budget only on cache misses', async () => {
    mocks.ensureSlidingWindow.mockResolvedValueOnce({ ok: false, retryAfterSec: 240 });
    const search = createUnsplashImageSearch({
      accessKey: 'server-key',
      cache: createCache().cache,
      fetchImpl: vi.fn(),
    });
    await expect(search(input())).rejects.toMatchObject({ kind: 'demo_rate_limited', retryAfterSec: 240 });
  });

  it('verifies selected photo metadata from Unsplash and tracks only the verified download location', async () => {
    const calls: string[] = [];
    const photoService = createUnsplashPhotoService({
      accessKey: 'server-key',
      fetchImpl: async (url, init) => {
        calls.push(String(url));
        expect(new Headers(init?.headers).get('authorization')).toBe('Client-ID server-key');
        if (String(url) === 'https://api.unsplash.com/photos/photo-1') {
          return new Response(JSON.stringify({
            ...photo,
            links: {
              ...photo.links,
              download_location: 'https://api.unsplash.com/photos/photo-1/download',
            },
          }), { status: 200 });
        }
        return new Response('{}', { status: 200 });
      },
    });

    const verified = await photoService.getById('photo-1');
    expect(verified.id).toBe('photo-1');
    expect(verified.creatorName).toBe('A. Photographer');
    expect(verified.downloadLocation).toBe('https://api.unsplash.com/photos/photo-1/download');
    await photoService.trackDownload(verified.downloadLocation);
    expect(calls).toEqual([
      'https://api.unsplash.com/photos/photo-1',
      'https://api.unsplash.com/photos/photo-1/download',
    ]);
    expect(mocks.ensureSlidingWindow).toHaveBeenCalledTimes(2);
  });

  it('rejects untrusted download URLs and invalid photo identifiers before provider requests', async () => {
    const fetchImpl = vi.fn();
    const photoService = createUnsplashPhotoService({ accessKey: 'server-key', fetchImpl });
    await expect(photoService.getById('https://attacker.example/photo')).rejects.toMatchObject({ kind: 'invalid_response' });
    await expect(photoService.trackDownload('https://attacker.example/photos/photo-1/download')).rejects.toMatchObject({ kind: 'invalid_response' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
