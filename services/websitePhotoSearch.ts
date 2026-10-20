import type { WebsiteDesignPreferences } from './websiteDesignPreferences';

const STYLE_TERMS: Record<WebsiteDesignPreferences['designPreset'], string> = {
  'coastal-editorial': 'coastal',
  'trustworthy-professional': 'professional',
  'creative-portfolio': 'creative',
  'local-service': 'local',
  'modern-business': 'modern',
};

const BACKGROUND_TERMS: Record<WebsiteDesignPreferences['backgroundStyle'], string> = {
  warm: 'warm',
  cool: 'cool',
  neutral: 'neutral',
  sage: 'sage',
};

export function buildWebsitePhotoSearchQuery(query: string, preferences?: WebsiteDesignPreferences): string {
  const subject = query.trim().replace(/\s+/g, ' ').slice(0, 100);
  if (!preferences) return subject;

  const layout = preferences.heroImageMode === 'background'
    ? 'wide hero'
    : preferences.heroImageMode === 'beside' ? 'copy space' : '';
  const mood = preferences.imageMood
    .replace(/[^\p{L}\p{N}\s,-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 28);
  const descriptors = [STYLE_TERMS[preferences.designPreset], BACKGROUND_TERMS[preferences.backgroundStyle], layout, mood]
    .filter(Boolean)
    .join(' ')
    .slice(0, 68);
  if (!descriptors) return subject;
  const subjectLimit = Math.max(24, 99 - descriptors.length);
  const conciseSubject = subject.slice(0, subjectLimit).trim();
  return `${conciseSubject} ${descriptors}`.trim().slice(0, 100);
}
