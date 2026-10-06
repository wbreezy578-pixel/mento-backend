import { randomUUID } from 'node:crypto';
import { resolveDesignPreset, type WebsiteDesignPreset } from './websiteDesignSystem';

export const WEBSITE_TYPES = ['business', 'restaurant', 'portfolio', 'professional', 'other'] as const;
export type WebsiteType = typeof WEBSITE_TYPES[number];

export const WEBSITE_SECTION_TYPES = ['hero', 'about', 'services', 'menu', 'gallery', 'location', 'contact', 'whatsapp'] as const;
export type WebsiteSectionType = typeof WEBSITE_SECTION_TYPES[number];

export interface WebsiteSection {
  id: string;
  type: WebsiteSectionType;
  title: string;
  body: string;
  imageSlotId: string | null;
}

export interface WebsitePage {
  id: string;
  slug: string;
  title: string;
  sections: WebsiteSection[];
}

export interface WebsiteMenuItem {
  id: string;
  name: string;
  description: string;
  price: string;
  currency: string;
  imageUrl: string | null;
  imageSlotId: string | null;
  available: boolean;
}

export interface WebsiteMenuCategory {
  id: string;
  name: string;
  items: WebsiteMenuItem[];
}

export type WebsiteImageRole = 'hero' | 'gallery' | 'menu_item' | 'section';

export interface WebsiteImageSlot {
  id: string;
  role: WebsiteImageRole;
  targetId: string | null;
  query: string;
  alt: string;
  assetId: string | null;
}

export interface WebsiteContent {
  schemaVersion: 1;
  type: WebsiteType;
  title: string;
  description: string;
  designPreset: WebsiteDesignPreset;
  theme: { primaryColor: string };
  pages: WebsitePage[];
  menuCategories: WebsiteMenuCategory[];
  imageSlots: WebsiteImageSlot[];
  galleryImageUrls: string[];
  contact: {
    address: string;
    phone: string;
    whatsappNumber: string;
    mapsUrl: string;
  };
  socialLinks: {
    instagram: string;
    facebook: string;
    tiktok: string;
  };
  seo: {
    title: string;
    description: string;
  };
}

const MAX_PAGES = 8;
const MAX_SECTIONS_PER_PAGE = 12;
const MAX_MENU_CATEGORIES = 12;
const MAX_MENU_ITEMS_PER_CATEGORY = 40;
const MAX_IMAGE_SLOTS = 8;
const SAFE_IMAGE_HOSTS = new Set(['images.unsplash.com', 'images.pexels.com']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= maxLength ? text : null;
}

function optionalText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function stableId(value: unknown, prefix: string, usedIds: Set<string>): string {
  const candidate = typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) && !usedIds.has(value)
    ? value
    : `${prefix}-${randomUUID()}`;
  usedIds.add(candidate);
  return candidate;
}

function safeImageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !SAFE_IMAGE_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function safeExternalUrl(value: unknown, maxLength = 2048): string {
  if (typeof value !== 'string' || value.length > maxLength) return '';
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function normalizeMenuCategories(value: unknown, usedIds: Set<string>): WebsiteMenuCategory[] | null {
  if (!Array.isArray(value) || value.length > MAX_MENU_CATEGORIES) return null;
  const categories: WebsiteMenuCategory[] = [];
  for (const rawCategory of value) {
    if (!isRecord(rawCategory) || !Array.isArray(rawCategory.items) || rawCategory.items.length > MAX_MENU_ITEMS_PER_CATEGORY) return null;
    const name = boundedText(rawCategory.name, 60);
    if (!name) return null;
    const items: WebsiteMenuItem[] = [];
    for (const rawItem of rawCategory.items) {
      if (!isRecord(rawItem)) return null;
      const itemName = boundedText(rawItem.name, 100);
      const price = optionalText(rawItem.price, 16);
      const currency = optionalText(rawItem.currency, 8);
      if (!itemName || (price && !/^\d{1,9}(?:[.,]\d{1,2})?$/.test(price)) || (currency && !/^[\p{L}]{1,8}$/u.test(currency))) return null;
      items.push({
        id: stableId(rawItem.id, 'item', usedIds),
        name: itemName,
        description: optionalText(rawItem.description, 240),
        price,
        currency: currency || 'KSh',
        imageUrl: safeImageUrl(rawItem.imageUrl),
        imageSlotId: typeof rawItem.imageSlotId === 'string' ? rawItem.imageSlotId.slice(0, 80) : null,
        available: typeof rawItem.available === 'boolean' ? rawItem.available : true,
      });
    }
    categories.push({ id: stableId(rawCategory.id, 'category', usedIds), name, items });
  }
  return categories;
}

function normalizePages(value: unknown, usedIds: Set<string>): WebsitePage[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PAGES) return null;
  const pages: WebsitePage[] = [];
  const slugs = new Set<string>();
  for (const rawPage of value) {
    if (!isRecord(rawPage) || !Array.isArray(rawPage.sections) || rawPage.sections.length < 1 || rawPage.sections.length > MAX_SECTIONS_PER_PAGE) return null;
    const title = boundedText(rawPage.title, 80);
    if (!title) return null;
    const rawSlug = optionalText(rawPage.slug, 80).toLowerCase();
    const slug = rawSlug.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'home';
    if (slugs.has(slug)) return null;
    slugs.add(slug);
    const sections: WebsiteSection[] = [];
    for (const rawSection of rawPage.sections) {
      if (!isRecord(rawSection) || !WEBSITE_SECTION_TYPES.includes(rawSection.type as WebsiteSectionType)) return null;
      const sectionTitle = boundedText(rawSection.title, 100);
      if (!sectionTitle) return null;
      sections.push({
        id: stableId(rawSection.id, 'section', usedIds),
        type: rawSection.type as WebsiteSectionType,
        title: sectionTitle,
        body: optionalText(rawSection.body, 1200),
        imageSlotId: typeof rawSection.imageSlotId === 'string' ? rawSection.imageSlotId.slice(0, 80) : null,
      });
    }
    pages.push({ id: stableId(rawPage.id, 'page', usedIds), slug, title, sections });
  }
  return pages;
}

function normalizeImageSlots(value: unknown, usedIds: Set<string>): WebsiteImageSlot[] | null {
  if (!Array.isArray(value) || value.length > MAX_IMAGE_SLOTS) return null;
  const roles: WebsiteImageRole[] = ['hero', 'gallery', 'menu_item', 'section'];
  const slots: WebsiteImageSlot[] = [];
  for (const rawSlot of value) {
    if (!isRecord(rawSlot) || !roles.includes(rawSlot.role as WebsiteImageRole)) return null;
    const query = boundedText(rawSlot.query, 180);
    const alt = boundedText(rawSlot.alt, 180);
    if (!query || !alt) return null;
    slots.push({
      id: stableId(rawSlot.id, 'image', usedIds),
      role: rawSlot.role as WebsiteImageRole,
      targetId: typeof rawSlot.targetId === 'string' ? rawSlot.targetId.slice(0, 80) : null,
      query,
      alt,
      assetId: typeof rawSlot.assetId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(rawSlot.assetId) ? rawSlot.assetId : null,
    });
  }
  return slots;
}

export function isWebsiteType(value: unknown): value is WebsiteType {
  return typeof value === 'string' && WEBSITE_TYPES.includes(value as WebsiteType);
}

export function normalizeWebsiteContent(value: unknown, fallbackType: WebsiteType = 'other'): WebsiteContent | null {
  if (!isRecord(value)) return null;
  const type = isWebsiteType(value.type) ? value.type : fallbackType;
  const title = boundedText(value.title, 100);
  const description = boundedText(value.description, 600);
  const usedIds = new Set<string>();
  const pages = normalizePages(value.pages, usedIds);
  const menuCategories = normalizeMenuCategories(value.menuCategories ?? [], usedIds);
  const imageSlots = normalizeImageSlots(value.imageSlots ?? [], usedIds);
  if (!title || !description || !pages || !menuCategories || !imageSlots) return null;

  const imageSlotIds = new Set(imageSlots.map((slot) => slot.id));
  for (const slot of imageSlots) {
    if (slot.targetId && !usedIds.has(slot.targetId)) return null;
  }
  for (const page of pages) {
    for (const section of page.sections) {
      if (section.imageSlotId && !imageSlotIds.has(section.imageSlotId)) return null;
    }
  }
  for (const category of menuCategories) {
    for (const item of category.items) {
      if (item.imageSlotId && !imageSlotIds.has(item.imageSlotId)) return null;
    }
  }

  const rawTheme = isRecord(value.theme) ? value.theme : {};
  const primaryColor = typeof rawTheme.primaryColor === 'string' && /^#[0-9A-Fa-f]{6}$/.test(rawTheme.primaryColor)
    ? rawTheme.primaryColor.toUpperCase()
    : '#0F8F83';
  const rawContact = isRecord(value.contact) ? value.contact : {};
  const rawSocialLinks = isRecord(value.socialLinks) ? value.socialLinks : {};
  const rawSeo = isRecord(value.seo) ? value.seo : {};
  const galleryImageUrls = Array.isArray(value.galleryImageUrls)
    ? value.galleryImageUrls.slice(0, 12).map(safeImageUrl).filter((url): url is string => url !== null)
    : [];

  return {
    schemaVersion: 1,
    type,
    title,
    description,
    designPreset: resolveDesignPreset(type, value.designPreset),
    theme: { primaryColor },
    pages,
    menuCategories,
    imageSlots,
    galleryImageUrls,
    contact: {
      address: optionalText(rawContact.address, 240),
      phone: optionalText(rawContact.phone, 40),
      whatsappNumber: optionalText(rawContact.whatsappNumber, 24).replace(/[^\d+]/g, '').slice(0, 16),
      mapsUrl: safeExternalUrl(rawContact.mapsUrl),
    },
    socialLinks: {
      instagram: safeExternalUrl(rawSocialLinks.instagram),
      facebook: safeExternalUrl(rawSocialLinks.facebook),
      tiktok: safeExternalUrl(rawSocialLinks.tiktok),
    },
    seo: {
      title: optionalText(rawSeo.title, 100) || title,
      description: optionalText(rawSeo.description, 320) || description,
    },
  };
}

export function parseWebsiteContent(response: string, fallbackType: WebsiteType = 'other'): WebsiteContent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    throw new Error('Gemini did not return valid website JSON.');
  }
  const content = normalizeWebsiteContent(parsed, fallbackType);
  if (!content) throw new Error('Gemini returned website content outside the supported structure.');
  return content;
}