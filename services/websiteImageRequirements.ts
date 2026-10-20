import { WEBSITE_TYPES, type WebsiteImageRole, type WebsiteType } from './websiteContent';

const IMAGE_ROLES = new Set<WebsiteImageRole>(['hero', 'gallery', 'menu_item', 'section']);
type WebsiteImageOrientation = 'landscape' | 'portrait' | 'square';

export interface WebsiteImageRequirement {
  id: string;
  targetId?: string;
  role: WebsiteImageRole;
  label: string;
  query: string;
  alt: string;
  orientation: WebsiteImageOrientation;
}

export interface WebsiteImageRequirements {
  type: WebsiteType;
  visualStyle: string;
  imageRequirements: WebsiteImageRequirement[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function parseWebsiteImageRequirements(value: unknown): WebsiteImageRequirements {
  if (typeof value === 'string') {
    try {
      return parseWebsiteImageRequirements(JSON.parse(value));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Gemini returned')) throw error;
      throw new Error('Gemini returned invalid image-requirement JSON.');
    }
  }
  if (!isRecord(value) || !WEBSITE_TYPES.includes(value.type as WebsiteType)
    || typeof value.visualStyle !== 'string' || !value.visualStyle.trim()
    || !Array.isArray(value.imageRequirements) || value.imageRequirements.length < 1 || value.imageRequirements.length > 8) {
    throw new Error('Gemini returned an incomplete image-requirements response.');
  }

  const seenIds = new Set<string>();
  const imageRequirements = value.imageRequirements.map((entry): WebsiteImageRequirement => {
    if (!isRecord(entry)
      || typeof entry.id !== 'string'
      || !/^[a-z0-9][a-z0-9_-]{0,59}$/.test(entry.id)
      || seenIds.has(entry.id)
      || (entry.targetId !== undefined && (
        typeof entry.targetId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(entry.targetId)
      ))
      || typeof entry.role !== 'string'
      || !IMAGE_ROLES.has(entry.role as WebsiteImageRole)
      || typeof entry.label !== 'string' || !entry.label.trim()
      || typeof entry.query !== 'string' || !entry.query.trim()
      || typeof entry.alt !== 'string' || !entry.alt.trim()
      || (entry.orientation !== 'landscape' && entry.orientation !== 'portrait' && entry.orientation !== 'square')) {
      throw new Error('Gemini returned an invalid image requirement.');
    }
    seenIds.add(entry.id);
    return {
      id: entry.id,
      ...(typeof entry.targetId === 'string' ? { targetId: entry.targetId } : {}),
      role: entry.role as WebsiteImageRole,
      label: entry.label.trim().slice(0, 80),
      query: entry.query.trim().slice(0, 120),
      alt: entry.alt.trim().slice(0, 180),
      orientation: entry.orientation,
    };
  });

  return {
    type: value.type as WebsiteType,
    visualStyle: value.visualStyle.trim().slice(0, 120),
    imageRequirements,
  };
}
