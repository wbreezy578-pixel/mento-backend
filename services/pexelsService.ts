export interface PexelsImageCandidate {
  provider: 'pexels';
  providerAssetId: string;
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

type PexelsPhotoResponse = {
  id?: unknown;
  width?: unknown;
  height?: unknown;
  url?: unknown;
  photographer?: unknown;
  photographer_url?: unknown;
  avg_color?: unknown;
  alt?: unknown;
  src?: Record<string, unknown>;
};

type CachedResults = { expiresAt: number; photos: PexelsImageCandidate[] };

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 400;
const SEARCH_RESULTS = 12;
const SEARCH_URL = 'https://api.pexels.com/v1/search';

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

function normalizePhoto(value: unknown, query: string): PexelsImageCandidate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const photo = value as PexelsPhotoResponse;
  const src = photo.src && typeof photo.src === 'object' ? photo.src : {};
  const imageUrl = safeHttpsUrl(src.landscape ?? src.large, ['images.pexels.com']);
  const previewUrl = safeHttpsUrl(src.medium ?? src.small ?? src.landscape, ['images.pexels.com']);
  const sourcePageUrl = safeHttpsUrl(photo.url, ['www.pexels.com', 'pexels.com']);
  const creatorProfileUrl = safeHttpsUrl(photo.photographer_url, ['www.pexels.com', 'pexels.com']);
  if (!imageUrl || !previewUrl || !sourcePageUrl || !creatorProfileUrl || typeof photo.id !== 'number') return null;
  return {
    provider: 'pexels',
    providerAssetId: String(photo.id),
    imageUrl,
    previewUrl,
    sourcePageUrl,
    creatorName: typeof photo.photographer === 'string' ? photo.photographer.slice(0, 120) : 'Pexels photographer',
    creatorProfileUrl,
    alt: typeof photo.alt === 'string' && photo.alt.trim() ? photo.alt.trim().slice(0, 180) : query,
    width: typeof photo.width === 'number' ? photo.width : 0,
    height: typeof photo.height === 'number' ? photo.height : 0,
    averageColor: typeof photo.avg_color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(photo.avg_color) ? photo.avg_color.toUpperCase() : null,
  };
}

export function createPexelsImageSearch(options: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CachedResults>();

  const search = async (query: string, orientation: 'landscape' | 'portrait' | 'square' = 'landscape'): Promise<PexelsImageCandidate[]> => {
    const cleanQuery = query.trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!cleanQuery) return [];
    if (!options.apiKey.trim()) throw new Error('Pexels image search is not configured.');
    const cacheKey = `${orientation}:${cleanQuery.toLowerCase()}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now()) return cached.photos;

    const url = new URL(SEARCH_URL);
    url.searchParams.set('query', cleanQuery);
    url.searchParams.set('orientation', orientation);
    url.searchParams.set('per_page', String(SEARCH_RESULTS));
    const response = await fetchImpl(url, {
      headers: { Authorization: options.apiKey.trim(), Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) {
      if (response.status === 429) throw new Error('Pexels image search is temporarily rate limited.');
      throw new Error(`Pexels image search failed with status ${response.status}.`);
    }
    const payload: unknown = await response.json();
    const photos = payload && typeof payload === 'object' && !Array.isArray(payload) && Array.isArray((payload as { photos?: unknown }).photos)
      ? (payload as { photos: unknown[] }).photos.map((photo) => normalizePhoto(photo, cleanQuery)).filter((photo): photo is PexelsImageCandidate => photo !== null)
      : [];
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey) cache.delete(oldestKey);
    }
    cache.set(cacheKey, { expiresAt: now() + CACHE_TTL_MS, photos });
    return photos;
  };

  const getById = async (providerAssetId: string): Promise<PexelsImageCandidate | null> => {
    if (!options.apiKey.trim()) throw new Error('Pexels image search is not configured.');
    if (!/^\d{1,16}$/.test(providerAssetId)) return null;
    const response = await fetchImpl(`https://api.pexels.com/v1/photos/${providerAssetId}`, {
      headers: { Authorization: options.apiKey.trim(), Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    });
    if (response.status === 404) return null;
    if (response.status === 429) throw new Error('Pexels image search is temporarily rate limited.');
    if (!response.ok) throw new Error(`Pexels image lookup failed with status ${response.status}.`);
    return normalizePhoto(await response.json(), 'Website image');
  };

  return { search, getById };
}

const pexelsImageSearch = createPexelsImageSearch({ apiKey: process.env.PEXELS_API_KEY ?? '' });

export async function searchPexelsImages(query: string, orientation: 'landscape' | 'portrait' | 'square' = 'landscape') {
  return pexelsImageSearch.search(query, orientation);
}

export async function getPexelsImageById(providerAssetId: string) {
  return pexelsImageSearch.getById(providerAssetId);
}