export const LIVE_TUTOR_PROFILES = {
  'female-avatar-profile': {
    tutorId: 'mento-female-tutor-v1',
    displayName: 'Mento Tutor',
    avatar: { provider: 'simli', configuration: 'current-female-avatar' },
    voiceProvider: 'gemini-live',
    voiceId: 'Kore',
    voiceGender: 'female',
    voiceCharacteristics: ['warm', 'clear', 'confident', 'natural'],
    personalityTraits: ['intelligent', 'patient', 'encouraging', 'attentive', 'friendly', 'professional'],
    tutoringStyle: ['explain difficult ideas simply', 'adapt to the learner level', 'use examples when useful', 'ask a short clarifying question only when needed'],
    speakingStyle: ['natural pacing', 'short responses for simple questions', 'more detail when teaching requires it', 'use occasional natural backchannels without overusing fillers'],
  },
  'male-avatar-profile': {
    tutorId: 'mento-male-tutor-reserved-v1',
    displayName: 'Reserved Tutor Profile',
    avatar: { provider: 'simli', configuration: 'reserved' },
    voiceProvider: 'gemini-live',
    voiceId: 'Charon',
    voiceGender: 'male',
    voiceCharacteristics: ['clear'],
    personalityTraits: [],
    tutoringStyle: [],
    speakingStyle: [],
  },
} as const;

export const LIVE_TUTOR_VOICE_PROFILES = LIVE_TUTOR_PROFILES;
export type LiveTutorVoiceProfile = keyof typeof LIVE_TUTOR_VOICE_PROFILES;

export const DEFAULT_LIVE_TUTOR_VOICE_PROFILE: LiveTutorVoiceProfile = 'female-avatar-profile';

export function resolveLiveTutorVoiceProfile(value: unknown): LiveTutorVoiceProfile | null {
  if (typeof value !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(LIVE_TUTOR_VOICE_PROFILES, value)
    ? value as LiveTutorVoiceProfile
    : null;
}

export function getGeminiVoiceForProfile(profile: LiveTutorVoiceProfile): string {
  return LIVE_TUTOR_VOICE_PROFILES[profile].voiceId;
}

export function getLiveTutorProfile(profile: LiveTutorVoiceProfile) {
  return LIVE_TUTOR_PROFILES[profile];
}