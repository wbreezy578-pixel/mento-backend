import { describe, expect, it } from 'vitest';
import { DEFAULT_LIVE_TUTOR_VOICE_PROFILE, getGeminiVoiceForProfile, getLiveTutorProfile, resolveLiveTutorVoiceProfile } from './liveTutorVoiceProfiles';

describe('Live Tutor voice profiles', () => {
  it('maps the female profile to the approved female Gemini voice', () => {
    expect(getGeminiVoiceForProfile('female-avatar-profile')).toBe('Kore');
  });

  it('maps the male profile to the approved male Gemini voice', () => {
    expect(getGeminiVoiceForProfile('male-avatar-profile')).toBe('Charon');
  });

  it('rejects arbitrary client voice names', () => {
    expect(resolveLiveTutorVoiceProfile('ArbitraryVoice')).toBeNull();
    expect(resolveLiveTutorVoiceProfile('female-avatar-profile')).toBe('female-avatar-profile');
  });

  it('uses the permanent female tutor profile by default', () => {
    expect(DEFAULT_LIVE_TUTOR_VOICE_PROFILE).toBe('female-avatar-profile');
    expect(getLiveTutorProfile(DEFAULT_LIVE_TUTOR_VOICE_PROFILE)).toMatchObject({
      tutorId: 'mento-female-tutor-v1',
      voiceProvider: 'gemini-live',
      voiceId: 'Kore',
      voiceGender: 'female',
    });
  });
});