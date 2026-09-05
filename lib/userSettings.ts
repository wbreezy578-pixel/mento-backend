import { prisma } from './prisma';

export const SUPPORTED_TUTOR_LANGUAGES = ['en', 'sw', 'es', 'fr', 'ar'] as const;
export type TutorLanguage = typeof SUPPORTED_TUTOR_LANGUAGES[number];

export function isTutorLanguage(value: unknown): value is TutorLanguage {
  return typeof value === 'string' && (SUPPORTED_TUTOR_LANGUAGES as readonly string[]).includes(value);
}

export async function getTutorLanguage(userId: string): Promise<TutorLanguage> {
  const settings = await prisma.userSetting.findUnique({ where: { userId }, select: { language: true } });
  return isTutorLanguage(settings?.language) ? settings.language : 'en';
}

export async function setTutorLanguage(userId: string, language: TutorLanguage) {
  return prisma.userSetting.upsert({
    where: { userId },
    update: { language },
    create: { userId, language },
    select: { language: true },
  });
}

export function buildTutorLanguageInstruction(language: TutorLanguage) {
  const names: Record<TutorLanguage, string> = {
    en: 'English', sw: 'Swahili', es: 'Spanish', fr: 'French', ar: 'Arabic',
  };
  return `Respond in ${names[language]} unless the user explicitly asks to use another language.`;
}
