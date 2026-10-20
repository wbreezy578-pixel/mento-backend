import { resolveDesignPreset, type WebsiteDesignPreset } from './websiteDesignSystem';
import type { WebsiteType } from './websiteContent';

export const WEBSITE_HERO_IMAGE_MODES = ['background', 'beside', 'none'] as const;
export const WEBSITE_BACKGROUND_STYLES = ['warm', 'cool', 'neutral', 'sage'] as const;
export const WEBSITE_OVERLAY_STRENGTHS = ['soft', 'balanced', 'strong'] as const;
export const WEBSITE_IMAGE_CROPS = ['center', 'top', 'bottom'] as const;

export type WebsiteHeroImageMode = typeof WEBSITE_HERO_IMAGE_MODES[number];
export type WebsiteBackgroundStyle = typeof WEBSITE_BACKGROUND_STYLES[number];
export type WebsiteOverlayStrength = typeof WEBSITE_OVERLAY_STRENGTHS[number];
export type WebsiteImageCrop = typeof WEBSITE_IMAGE_CROPS[number];

export interface WebsiteDesignPreferences {
  designPreset: WebsiteDesignPreset;
  heroImageMode: WebsiteHeroImageMode;
  backgroundStyle: WebsiteBackgroundStyle;
  overlayStrength: WebsiteOverlayStrength;
  imageCrop: WebsiteImageCrop;
  imageMood: string;
}

const DEFAULT_PREFERENCES: Omit<WebsiteDesignPreferences, 'designPreset'> = {
  heroImageMode: 'background',
  backgroundStyle: 'warm',
  overlayStrength: 'balanced',
  imageCrop: 'center',
  imageMood: '',
};

export const WEBSITE_BACKGROUND_PALETTES: Record<WebsiteBackgroundStyle, { backgroundColor: string; surfaceColor: string }> = {
  warm: { backgroundColor: '#FBF8F1', surfaceColor: '#F1E9DB' },
  cool: { backgroundColor: '#F5F8FA', surfaceColor: '#E7EFF3' },
  neutral: { backgroundColor: '#FAF9F6', surfaceColor: '#EFEEE9' },
  sage: { backgroundColor: '#F6F8F3', surfaceColor: '#E8EEE5' },
};

export function defaultWebsiteDesignPreferences(type: WebsiteType): WebsiteDesignPreferences {
  return { ...DEFAULT_PREFERENCES, designPreset: resolveDesignPreset(type, undefined) };
}

export function parseWebsiteDesignPreferences(
  value: unknown,
  type: WebsiteType,
): WebsiteDesignPreferences | null {
  if (value === undefined || value === null) return defaultWebsiteDesignPreferences(type);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const preset = resolveDesignPreset(type, raw.designPreset);
  const hasValidPreset = typeof raw.designPreset === 'string'
    && ['coastal-editorial', 'trustworthy-professional', 'creative-portfolio', 'local-service', 'modern-business'].includes(raw.designPreset);
  const heroImageMode = raw.heroImageMode;
  const backgroundStyle = raw.backgroundStyle;
  const overlayStrength = raw.overlayStrength;
  const imageCrop = raw.imageCrop;
  const imageMood = typeof raw.imageMood === 'string' ? raw.imageMood.trim() : '';

  if (
    !hasValidPreset
    || !WEBSITE_HERO_IMAGE_MODES.includes(heroImageMode as WebsiteHeroImageMode)
    || !WEBSITE_BACKGROUND_STYLES.includes(backgroundStyle as WebsiteBackgroundStyle)
    || !WEBSITE_OVERLAY_STRENGTHS.includes(overlayStrength as WebsiteOverlayStrength)
    || !WEBSITE_IMAGE_CROPS.includes(imageCrop as WebsiteImageCrop)
    || imageMood.length > 180
  ) return null;

  return {
    designPreset: preset,
    heroImageMode: heroImageMode as WebsiteHeroImageMode,
    backgroundStyle: backgroundStyle as WebsiteBackgroundStyle,
    overlayStrength: overlayStrength as WebsiteOverlayStrength,
    imageCrop: imageCrop as WebsiteImageCrop,
    imageMood,
  };
}
