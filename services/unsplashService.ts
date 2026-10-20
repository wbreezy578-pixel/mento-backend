import { createHash } from 'node:crypto';
import { createRedisClient, type MentoRedisClient } from '../lib/redisClient';
import { getRedisUrl } from '../lib/env';
import { ensureSlidingWindow } from '../lib/rateLimiter';
import logger from '../lib/logger';

const API_URL = 'https://api.unsplash.com/search/photos';
const CACHE_TTL_SECONDS = 30 * 60;
const REQUEST_TIMEOUT_MS = 8_000;
const CACHE_PREFIX = 'cache:webs:unsplash:v1:';
const DEMO_PROVIDER_LIMIT_PER_HOUR = 45;
const PROVIDER_WINDOW_SECONDS = 60 * 60;

export type UnsplashOrientation = 'landscape' | 'portrait' | 'square' | 'any';

export interface UnsplashImageResult {
  id: string;
  imageUrl: string;
  previewUrl: string;
  sourcePageUrl: string;
  creatorName: string;
  creatorProfileUrl: string;
  alt: string;
  width: number;
  height: number;
  averageColor: string | null;
}

export interface UnsplashImageSearchResponse {
  results: UnsplashImageResult[];
  total: number;
  totalPages: number;
}

export interface VerifiedUnsplashPhoto extends UnsplashImageResult {
  downloadLocation: string;
}

export interface UnsplashSearchCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

type UnsplashPhotoResponse = {
  id?: unknown;
  width?: unknown;
  height?: unknown;
  urls?: Record<string, unknown>;
  links?: Record<string, unknown>;
  alt_description?: unknown;
  description?: unknown;
  color?: unknown;
  user?: {
    name?: unknown;
    links?: Record<string, unknown>;
  };
};

type SearchInput = {
  query: string;
  page: number;
  perPage: number;
  orientation: UnsplashOrientation;
};

export type UnsplashSearchErrorKind = 'not_configured' | 'timeout' | 'rate_limited' | 'demo_rate_limited' | 'rate_limiter_unavailable' | 'provider_unavailable' | 'invalid_response';

export class UnsplashSearchError extends Error {
  constructor(
    readonly kind: UnsplashSearchErrorKind,
    readonly retryAfterSec?: number,
    readonly providerStatus?: number,
  ) {
    super(kind);
    this.name = 'UnsplashSearchError';
  }
}

function safeHttpsUrl(value: unknown, hosts: string[]): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !hosts.includes(url.hostname.toLowerCase()) || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function addAttributionParams(value: string): string {
  const url = new URL(value);
  url.searchParams.set('utm_source', 'mento');
  url.searchParams.set('utm_medium', 'referral');
  return url.toString();
}

function safeDownloadLocation(value: unknown, photoId: string): string | null {
  const url = safeHttpsUrl(value, ['api.unsplash.com']);
  if (!url) return null;
  const parsed = new URL(url);
  return parsed.pathname === `/photos/${photoId}/download` ? parsed.toString() : null;
}

function normalizePhoto(value: unknown, query: string): UnsplashImageResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const photo = value as UnsplashPhotoResponse;
  const urls = photo.urls && typeof photo.urls === 'object' ? photo.urls : {};
  const links = photo.links && typeof photo.links === 'object' ? photo.links : {};
  const user = photo.user && typeof photo.user === 'object' ? photo.user : {};
  const userLinks = user.links && typeof user.links === 'object' ? user.links : {};
  const imageUrl = safeHttpsUrl(urls.regular ?? urls.full ?? urls.raw, ['images.unsplash.com']);
  const previewUrl = safeHttpsUrl(urls.small ?? urls.thumb ?? urls.regular, ['images.unsplash.com']);
  const sourcePageUrl = safeHttpsUrl(links.html, ['unsplash.com', 'www.unsplash.com']);
  const creatorProfileUrl = safeHttpsUrl(userLinks.html, ['unsplash.com', 'www.unsplash.com']);
  if (
    typeof photo.id !== 'string'
    || !/^[A-Za-z0-9_-]{1,200}$/.test(photo.id)
    || !imageUrl
    || !previewUrl
    || !sourcePageUrl
    || !creatorProfileUrl
  ) return null;

  const description = typeof photo.alt_description === 'string' && photo.alt_description.trim()
    ? photo.alt_description
    : typeof photo.description === 'string' && photo.description.trim() ? photo.description : query;
  return {
    id: photo.id,
    imageUrl,
    previewUrl,
    sourcePageUrl: addAttributionParams(sourcePageUrl),
    creatorName: typeof user.name === 'string' && user.name.trim() ? user.name.trim().slice(0, 120) : 'Unsplash photographer',
    creatorProfileUrl: addAttributionParams(creatorProfileUrl),
    alt: description.trim().slice(0, 180),
    width: typeof photo.width === 'number' && Number.isSafeInteger(photo.width) && photo.width > 0 ? photo.width : 0,
    height: typeof photo.height === 'number' && Number.isSafeInteger(photo.height) && photo.height > 0 ? photo.height : 0,
    averageColor: typeof photo.color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(photo.color) ? photo.color.toUpperCase() : null,
  };
}

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ');
}

function cacheKey(input: SearchInput, normalizedQuery: string): string {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([normalizedQuery.toLowerCase(), input.page, input.perPage, input.orientation]))
    .digest('hex');
  return `${CACHE_PREFIX}${fingerprint}`;
}

function parseCachedResponse(value: string): UnsplashImageSearchResponse | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !parsed
      || typeof parsed !== 'object'
      || !Array.isArray((parsed as UnsplashImageSearchResponse).results)
      || !Number.isSafeInteger((parsed as UnsplashImageSearchResponse).total)
      || !Number.isSafeInteger((parsed as UnsplashImageSearchResponse).totalPages)
    ) return null;
    return parsed as UnsplashImageSearchResponse;
  } catch {
    return null;
  }
}

let redisCacheClient: MentoRedisClient | null = null;
let redisCacheUrl: string | null = null;

function getRedisCacheClient(): MentoRedisClient {
  const url = getRedisUrl();
  if (!url) throw new Error('Shared Redis cache is not configured.');
  if (!redisCacheClient || redisCacheUrl !== url) {
    redisCacheClient = createRedisClient(url);
    redisCacheUrl = url;
  }
  return redisCacheClient;
}

async function getReadyRedisCacheClient(): Promise<MentoRedisClient> {
  const client = getRedisCacheClient();
  if (client.status === 'ready') return client;
  if (client.status === 'end') throw new Error('Shared Redis cache is unavailable.');

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.removeListener('ready', onReady);
      client.removeListener('error', onUnavailable);
      client.removeListener('end', onUnavailable);
      if (ready && client.status === 'ready') resolve(client);
      else reject(new Error('Shared Redis cache is unavailable.'));
    };
    const onReady = () => settle(true);
    const onUnavailable = () => settle(false);
    const timeout = setTimeout(() => settle(client.status === 'ready'), 1_500);

    client.once('ready', onReady);
    client.once('error', onUnavailable);
    client.once('end', onUnavailable);
    if (client.status === 'ready') settle(true);
  });
}

const sharedSearchCache: UnsplashSearchCache = {
  async get(key) {
    return (await getReadyRedisCacheClient()).get(key);
  },
  async set(key, value, ttlSeconds) {
    await (await getReadyRedisCacheClient()).set(key, value, 'EX', ttlSeconds);
  },
};

async function enforceProviderBudget(): Promise<void> {
  const providerLimit = await ensureSlidingWindow(
    'global',
    DEMO_PROVIDER_LIMIT_PER_HOUR,
    PROVIDER_WINDOW_SECONDS,
    'rl:webs:unsplash:provider',
    { requireDistributed: true },
  );
  if (!providerLimit.ok) {
    throw new UnsplashSearchError(
      providerLimit.unavailable ? 'rate_limiter_unavailable' : 'demo_rate_limited',
      providerLimit.retryAfterSec,
    );
  }
}

export function createUnsplashPhotoService(options: {
  accessKey: string;
  fetchImpl?: typeof fetch;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const request = async (path: string) => {
    if (!options.accessKey.trim()) throw new UnsplashSearchError('not_configured');
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(`https://api.unsplash.com${path}`, {
        headers: {
          Authorization: `Client-ID ${options.accessKey.trim()}`,
          'Accept-Version': 'v1',
          Accept: 'application/json',
        },
        signal: timeoutSignal,
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      throw new UnsplashSearchError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'provider_unavailable');
    }
    if (response.status === 429) throw new UnsplashSearchError('rate_limited', undefined, response.status);
    if (!response.ok) throw new UnsplashSearchError('provider_unavailable', undefined, response.status);
    return { response, timeoutSignal };
  };

  const getById = async (photoId: string): Promise<VerifiedUnsplashPhoto> => {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(photoId)) throw new UnsplashSearchError('invalid_response');
    await enforceProviderBudget();
    const { response, timeoutSignal } = await request(`/photos/${encodeURIComponent(photoId)}`);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new UnsplashSearchError(timeoutSignal.aborted ? 'timeout' : 'invalid_response');
    }
    const photo = normalizePhoto(payload, 'Website photo');
    const rawLinks = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as UnsplashPhotoResponse).links
      : undefined;
    const downloadLocation = safeDownloadLocation(rawLinks?.download_location, photoId);
    if (!photo || photo.id !== photoId || !downloadLocation) throw new UnsplashSearchError('invalid_response');
    return { ...photo, downloadLocation };
  };

  const trackDownload = async (downloadLocation: string): Promise<void> => {
    let url: URL;
    try {
      url = new URL(downloadLocation);
    } catch {
      throw new UnsplashSearchError('invalid_response');
    }
    if (
      url.protocol !== 'https:'
      || url.origin !== 'https://api.unsplash.com'
      || !/^\/photos\/[A-Za-z0-9_-]{1,200}\/download$/.test(url.pathname)
    ) throw new UnsplashSearchError('invalid_response');
    await enforceProviderBudget();
    const { response } = await request(`${url.pathname}${url.search}`);
    await response.body?.cancel();
  };

  return { getById, trackDownload };
}

export function createUnsplashImageSearch(options: {
  accessKey: string;
  cache?: UnsplashSearchCache;
  fetchImpl?: typeof fetch;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const cache = options.cache ?? sharedSearchCache;

  return async function search(input: SearchInput): Promise<UnsplashImageSearchResponse> {
    const query = normalizeQuery(input.query);
    if (!options.accessKey.trim()) throw new UnsplashSearchError('not_configured');
    const key = cacheKey(input, query);

    try {
      const cached = await cache.get(key);
      if (cached) {
        const parsed = parseCachedResponse(cached);
        if (parsed) return parsed;
        logger.warn('Unsplash search cache entry was invalid', { category: 'unsplash_cache_invalid' });
      }
    } catch (error) {
      logger.warn('Unsplash search cache read failed', {
        category: 'unsplash_cache_read_failed',
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }

    await enforceProviderBudget();

    const url = new URL(API_URL);
    url.searchParams.set('query', query);
    url.searchParams.set('page', String(input.page));
    url.searchParams.set('per_page', String(input.perPage));
    if (input.orientation !== 'any') {
      url.searchParams.set('orientation', input.orientation === 'square' ? 'squarish' : input.orientation);
    }

    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: {
          Authorization: `Client-ID ${options.accessKey.trim()}`,
          'Accept-Version': 'v1',
          Accept: 'application/json',
        },
        signal: timeoutSignal,
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      throw new UnsplashSearchError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'provider_unavailable');
    }

    if (response.status === 429) throw new UnsplashSearchError('rate_limited', undefined, response.status);
    if (!response.ok) throw new UnsplashSearchError('provider_unavailable', undefined, response.status);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new UnsplashSearchError(timeoutSignal.aborted ? 'timeout' : 'invalid_response');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray((payload as { results?: unknown }).results)) {
      throw new UnsplashSearchError('invalid_response');
    }

    const body = payload as { results: unknown[]; total?: unknown; total_pages?: unknown };
    const result: UnsplashImageSearchResponse = {
      results: body.results
        .map((photo) => normalizePhoto(photo, query))
        .filter((photo): photo is UnsplashImageResult => photo !== null),
      total: typeof body.total === 'number' && Number.isSafeInteger(body.total) && body.total >= 0 ? body.total : 0,
      totalPages: typeof body.total_pages === 'number' && Number.isSafeInteger(body.total_pages) && body.total_pages >= 0 ? body.total_pages : 0,
    };

    try {
      await cache.set(key, JSON.stringify(result), CACHE_TTL_SECONDS);
    } catch (error) {
      logger.warn('Unsplash search cache write failed', {
        category: 'unsplash_cache_write_failed',
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
    return result;
  };
}

const searchUnsplash = createUnsplashImageSearch({ accessKey: process.env.UNSPLASH_ACCESS_KEY ?? '' });
const unsplashPhotoService = createUnsplashPhotoService({ accessKey: process.env.UNSPLASH_ACCESS_KEY ?? '' });

export async function searchUnsplashImages(input: SearchInput): Promise<UnsplashImageSearchResponse> {
  return searchUnsplash(input);
}

export async function getVerifiedUnsplashPhoto(photoId: string): Promise<VerifiedUnsplashPhoto> {
  return unsplashPhotoService.getById(photoId);
}

export async function trackUnsplashPhotoDownload(downloadLocation: string): Promise<void> {
  return unsplashPhotoService.trackDownload(downloadLocation);
}
