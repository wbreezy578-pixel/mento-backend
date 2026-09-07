import { describe, it, expect, vi } from 'vitest';
vi.mock('../lib/logger', () => ({ default: { info: vi.fn() } }));
vi.mock('../lib/metrics', () => ({ observeLiveTutorVoiceLatency: vi.fn() }));
import { isDeviceVoiceEvent, metrics } from './liveTutorVoiceTelemetry';

describe('Live Tutor clock-domain latency', () => {
  it('does not let client telemetry impersonate provider events', () => {
    expect(isDeviceVoiceEvent('USER_SPEECH_ENDED')).toBe(true);
    expect(isDeviceVoiceEvent('GEMINI_FIRST_AUDIO_RECEIVED')).toBe(false);
    expect(isDeviceVoiceEvent('GEMINI_TURN_COMMITTED')).toBe(false);
  });
  it('does not subtract unsynchronized device/server clocks', () => {
    const result = metrics({ USER_SPEECH_ENDED: 90_000, GEMINI_FIRST_AUDIO_RECEIVED: 1_000,
      BACKEND_FIRST_PCM_16K_SENT: 1_020, FRONTEND_FIRST_PCM_RECEIVED: 90_500, SIMLI_FIRST_AUDIO_PLAYED: 90_600 });
    expect(result.userSpeechEndToGeminiFirstAudioMs).toBeNull();
    expect(result.backendPcmSentToFrontendReceivedMs).toBeNull();
    expect(result.geminiAudioToBackendPcmSentMs).toBe(20);
    expect(result.totalSpeechEndToFirstAudibleResponseMs).toBe(600);
    expect(result.frontendReceivedToSimliPlayedMs).toBe(100);
  });
  it('does not disguise reversed or invalid clocks as zero latency', () => {
    expect(metrics({ USER_SPEECH_ENDED: 200, SIMLI_FIRST_AUDIO_PLAYED: 100 }).totalSpeechEndToFirstAudibleResponseMs).toBeNull();
    expect(metrics({ USER_SPEECH_ENDED: NaN, SIMLI_FIRST_AUDIO_PLAYED: 100 }).totalSpeechEndToFirstAudibleResponseMs).toBeNull();
  });
});

it('measures processing and interruption on the device clock without confusing Simli signaling with playback', () => {
  const result = metrics({ USER_SPEECH_ENDED: 1000, RESPONSE_STARTING: 1001, THINKING_STARTED: 2200,
    RESPONSE_STARTED: 2300, THINKING_ENDED: 2300, FRONTEND_FIRST_PCM_RECEIVED: 2320,
    SIMLI_SPEAKING_SIGNAL: 2400, INTERRUPTION_STARTED: 2500, LISTENING_REOPENED: 2501 });
  expect(result.speechEndedToThinkingStateMs).toBe(1200);
  expect(result.speechEndedToResponseStartedMs).toBe(1300);
  expect(result.responseStartedToFirstAudioMs).toBe(20);
  expect(result.totalThinkingStateDurationMs).toBe(100);
  expect(result.interruptionToListeningMs).toBe(1);
  expect(result.firstAudioToSimliSpeakingSignalMs).toBe(80);
  expect(result.totalSpeechEndToFirstAudibleResponseMs).toBeNull();
});
