import { randomUUID } from 'node:crypto';
import { normalizeWebsitePalette, resolveDesignPreset, type WebsiteDesignPreset } from './websiteDesignSystem';

export const WEBSITE_TYPES = ['business', 'restaurant', 'portfolio', 'professional', 'other'] as const;
export type WebsiteType = typeof WEBSITE_TYPES[number];

export const WEBSITE_SECTION_TYPES = ['hero', 'about', 'services', 'menu', 'gallery', 'location', 'contact', 'whatsapp'] as const;
export type WebsiteSectionType = typeof WEBSITE_SECTION_TYPES[number];

export const WEBSITE_HERO_LAYOUT_VARIANTS = ['cinematic', 'split', 'centered-editorial'] as const;
export type WebsiteHeroLayoutVariant = typeof WEBSITE_HERO_LAYOUT_VARIANTS[number];

export interface WebsiteSection {
  id: string;
  type: WebsiteSectionType;
  title: string;
  body: string;
  imageSlotId: string | null;
  layoutVariant?: WebsiteHeroLayoutVariant;
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
  theme: {
    primaryColor: string;
    secondaryColor: string;
    backgroundColor: string;
    surfaceColor: string;
  };
  pages: WebsitePage[];
  menuCategories: WebsiteMenuCategory[];
  imageSlots: WebsiteImageSlot[];
  galleryImageUrls: string[];
  contact: {
    address: string;
    phone: string;
    whatsappNumber: string;
    mapsUrl: string;
    email: string;
    openingHours: string;
    serviceArea: string;
    servicesAndPricing: string;
    testimonials: string;
    bookingUrl: string;
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
const MAX_IMAGE_SLOTS = 32;
const SAFE_IMAGE_HOSTS = new Set(['images.unsplash.com', 'images.pexels.com']);
const WEBSITE_CONTACT_TEXT_LIMITS = {
  address: 240,
  phone: 40,
  whatsappNumber: 24,
  email: 254,
  openingHours: 800,
  serviceArea: 240,
  servicesAndPricing: 1200,
  testimonials: 1200,
} as const;

export type WebsiteContact = {
  -readonly [Key in keyof typeof WEBSITE_CONTACT_TEXT_LIMITS]: string;
} & {
  mapsUrl: string;
  bookingUrl: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function isWebsiteHeroLayoutVariant(value: unknown): value is WebsiteHeroLayoutVariant {
  return typeof value === 'string' && WEBSITE_HERO_LAYOUT_VARIANTS.includes(value as WebsiteHeroLayoutVariant);
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

export function buildWebsiteTrustInstruction(): string {
  return 'Use verified information only. Include contact channels, opening hours, service area/location, services/prices, exact owner-approved testimonials, and booking/enquiry links only when the owner supplies them. Never invent or embellish these facts. Omit missing details without placeholders or “coming soon/add this later” copy. Preserve all supplied prices, hours, contact information, and testimonial wording exactly. Put supplied servicesAndPricing in the services or menu section when one exists, otherwise in contact; do not duplicate it. Return contact with address, phone, whatsappNumber, mapsUrl, email, openingHours, serviceArea, servicesAndPricing, testimonials, and bookingUrl strings.';
}

export function parseWebsiteContact(value: unknown): WebsiteContact | null {
  if (!isRecord(value)) return null;
  const textFields = Object.entries(WEBSITE_CONTACT_TEXT_LIMITS) as Array<[keyof typeof WEBSITE_CONTACT_TEXT_LIMITS, number]>;
  const contact = {} as WebsiteContact;
  for (const [field, maxLength] of textFields) {
    const raw = value[field];
    if (typeof raw !== 'string' || raw.length > maxLength) return null;
    contact[field] = raw.trim();
  }
  for (const field of ['mapsUrl', 'bookingUrl'] as const) {
    const raw = value[field];
    if (typeof raw !== 'string' || raw.length > 2048) return null;
    const url = safeExternalUrl(raw);
    if (raw.trim() && !url) return null;
    contact[field] = url;
  }
  if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) return null;
  contact.whatsappNumber = contact.whatsappNumber.replace(/[^\d+]/g, '').slice(0, 16);
  return contact;
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
      if (!itemName || (price && !/^\d{1,7}(?:[.,]\d{1,2})?$/.test(price)) || (currency && !/^[\p{L}]{1,8}$/u.test(currency))) return null;
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
      if (rawSection.layoutVariant !== undefined && (
        rawSection.type !== 'hero' || !isWebsiteHeroLayoutVariant(rawSection.layoutVariant)
      )) return null;
      const sectionTitle = boundedText(rawSection.title, 100);
      if (!sectionTitle) return null;
      sections.push({
        id: stableId(rawSection.id, 'section', usedIds),
        type: rawSection.type as WebsiteSectionType,
        title: sectionTitle,
        body: optionalText(rawSection.body, 1200),
        imageSlotId: typeof rawSection.imageSlotId === 'string' ? rawSection.imageSlotId.slice(0, 80) : null,
        ...(rawSection.layoutVariant === undefined ? {} : { layoutVariant: rawSection.layoutVariant }),
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
  const designPreset = resolveDesignPreset(type, value.designPreset);
  const theme = normalizeWebsitePalette(rawTheme, designPreset);
  const rawContact = isRecord(value.contact) ? value.contact : {};
  const email = optionalText(rawContact.email, WEBSITE_CONTACT_TEXT_LIMITS.email);
  const contact = {
    address: optionalText(rawContact.address, WEBSITE_CONTACT_TEXT_LIMITS.address),
    phone: optionalText(rawContact.phone, WEBSITE_CONTACT_TEXT_LIMITS.phone),
    whatsappNumber: optionalText(rawContact.whatsappNumber, WEBSITE_CONTACT_TEXT_LIMITS.whatsappNumber).replace(/[^\d+]/g, '').slice(0, 16),
    mapsUrl: safeExternalUrl(rawContact.mapsUrl),
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '',
    openingHours: optionalText(rawContact.openingHours, WEBSITE_CONTACT_TEXT_LIMITS.openingHours),
    serviceArea: optionalText(rawContact.serviceArea, WEBSITE_CONTACT_TEXT_LIMITS.serviceArea),
    servicesAndPricing: optionalText(rawContact.servicesAndPricing, WEBSITE_CONTACT_TEXT_LIMITS.servicesAndPricing),
    testimonials: optionalText(rawContact.testimonials, WEBSITE_CONTACT_TEXT_LIMITS.testimonials),
    bookingUrl: safeExternalUrl(rawContact.bookingUrl),
  };
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
    designPreset,
    theme,
    pages,
    menuCategories,
    imageSlots,
    galleryImageUrls,
    contact,
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

export function preserveWebsiteImageSlots(existing: WebsiteContent, edited: WebsiteContent): WebsiteContent {
  const editedSections = new Map(edited.pages.flatMap((page) => page.sections.map((section) => [section.id, section] as const)));
  const editedMenuItems = new Map(edited.menuCategories.flatMap((category) => category.items.map((item) => [item.id, item] as const)));
  const preservedSlots = existing.imageSlots.filter((slot) => {
    if (!slot.targetId) return true;
    if (slot.role === 'menu_item') return editedMenuItems.has(slot.targetId);
    const section = editedSections.get(slot.targetId);
    if (!section) return false;
    if (slot.role === 'hero') return section.type === 'hero';
    if (slot.role === 'gallery') return section.type === 'gallery';
    return section.type === 'about' || section.type === 'services';
  });
  const preservedSlotIds = new Set(preservedSlots.map((slot) => slot.id));
  const imageSlots = edited.imageSlots.filter((slot) => !preservedSlots.some((previous) => (
    previous.id === slot.id || (previous.role === slot.role && previous.targetId === slot.targetId)
  )));
  imageSlots.push(...preservedSlots);

  return {
    ...edited,
    pages: edited.pages.map((page) => ({
      ...page,
      sections: page.sections.map((section) => {
        const previous = existing.pages.flatMap((currentPage) => currentPage.sections)
          .find((candidate) => candidate.id === section.id);
        const slotId = previous?.imageSlotId;
        return slotId && preservedSlotIds.has(slotId) ? { ...section, imageSlotId: slotId } : section;
      }),
    })),
    menuCategories: edited.menuCategories.map((category) => ({
      ...category,
      items: category.items.map((item) => {
        const previous = existing.menuCategories.flatMap((currentCategory) => currentCategory.items)
          .find((candidate) => candidate.id === item.id);
        const slotId = previous?.imageSlotId;
        return slotId && preservedSlotIds.has(slotId) ? { ...item, imageSlotId: slotId } : item;
      }),
    })),
    imageSlots,
  };
}

export function requestsWebsiteHeroLayoutChange(prompt: string): boolean {
  return /\b(?:hero|banner)\b[\s\S]{0,80}\b(?:cinematic|split|centered(?:[\s-]+editorial)?)\b/i.test(prompt)
    || /\b(?:cinematic|split|centered(?:[\s-]+editorial)?)\b[\s\S]{0,80}\b(?:hero|banner)\b/i.test(prompt);
}

export function preserveWebsiteHeroLayout(
  existing: WebsiteContent,
  edited: WebsiteContent,
  allowRequestedChange = false,
): WebsiteContent {
  const replacements = new Map<string, WebsiteSection>();
  existing.pages.forEach((existingPage, pageIndex) => {
    const editedPage = edited.pages.find((page) => page.id === existingPage.id)
      ?? edited.pages.find((page) => page.slug === existingPage.slug)
      ?? edited.pages[pageIndex];
    if (!editedPage) return;

    const existingHeroes = existingPage.sections.filter((section) => section.type === 'hero');
    const editedHeroes = editedPage.sections.filter((section) => section.type === 'hero');
    existingHeroes.forEach((previous, heroIndex) => {
      const current = editedHeroes.find((section) => section.id === previous.id) ?? editedHeroes[heroIndex];
      if (!current) return;

      const layoutVariant = allowRequestedChange && current.layoutVariant
        ? current.layoutVariant
        : previous.layoutVariant;
      const sectionWithoutLayout = { ...current };
      delete sectionWithoutLayout.layoutVariant;
      replacements.set(current.id, {
        ...sectionWithoutLayout,
        id: previous.id,
        ...(layoutVariant ? { layoutVariant } : {}),
      });
    });
  });

  return {
    ...edited,
    pages: edited.pages.map((page) => ({
      ...page,
      sections: page.sections.map((section) => replacements.get(section.id) ?? section),
    })),
  };
}

export function preserveWebsiteContentExceptHeroLayout(existing: WebsiteContent, edited: WebsiteContent): WebsiteContent {
  const editedSections = new Map(edited.pages.flatMap((page) => page.sections.map((section) => [section.id, section] as const)));
  return {
    ...existing,
    pages: existing.pages.map((page) => ({
      ...page,
      sections: page.sections.map((section) => {
        if (section.type !== 'hero') return section;
        const editedSection = editedSections.get(section.id);
        return editedSection?.type === 'hero' && editedSection.layoutVariant
          ? { ...section, layoutVariant: editedSection.layoutVariant }
          : section;
      }),
    })),
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