import logger from '../lib/logger';
import { observeLiveTutorVoiceLatency } from '../lib/metrics';

export const LIVE_TUTOR_VOICE_EVENTS = [
  'USER_SPEECH_STARTED',
  'USER_SPEECH_ENDED',
  'USER_AUDIO_LAST_CHUNK_SENT',
  'GEMINI_TURN_COMMITTED',
  'GEMINI_INPUT_TRANSCRIPT_FINAL',
  'GEMINI_FIRST_MESSAGE',
  'GEMINI_FIRST_OUTPUT_TRANSCRIPT',
  'GEMINI_FIRST_AUDIO_RECEIVED',
  'GEMINI_RESAMPLE_STARTED',
  'GEMINI_RESAMPLE_ENDED',
  'BACKEND_FIRST_PCM_16K_SENT',
  'FRONTEND_FIRST_PCM_RECEIVED',
  'SIMLI_FIRST_AUDIO_PLAYED',
  'GEMINI_TURN_COMPLETE',
  'AVATAR_AUDIO_PLAYBACK_COMPLETE',
  'LISTENING_REOPENED',
] as const;

export type LiveTutorVoiceEvent = (typeof LIVE_TUTOR_VOICE_EVENTS)[number];

type Timeline = Partial<Record<LiveTutorVoiceEvent, number>>;

type VoiceTelemetryIdentity = {
  sessionId: string;
  turnNumber: number;
  generationId: number;
  streamId?: string | null;
  voiceTraceId?: string | null;
};

const timelines = new Map<string, Timeline>();
const totalLatencySamplesBySession = new Map<string, number[]>();
function keyFor(identity: VoiceTelemetryIdentity): string {
  return `${identity.sessionId}:${identity.turnNumber}:${identity.generationId}`;
}

const deviceEvents = new Set<LiveTutorVoiceEvent>([
  'USER_SPEECH_STARTED', 'USER_SPEECH_ENDED', 'USER_AUDIO_LAST_CHUNK_SENT',
  'FRONTEND_FIRST_PCM_RECEIVED', 'SIMLI_FIRST_AUDIO_PLAYED',
  'AVATAR_AUDIO_PLAYBACK_COMPLETE', 'LISTENING_REOPENED',
]);

export function isDeviceVoiceEvent(event: string): event is LiveTutorVoiceEvent {
  return deviceEvents.has(event as LiveTutorVoiceEvent);
}

export function metrics(timeline: Timeline) {
  const delta = (from: LiveTutorVoiceEvent, to: LiveTutorVoiceEvent) => {
    const start = timeline[from];
    const end = timeline[to];
    // Device and server clocks are not synchronized. Never manufacture latency
    // from their difference, or turn a reversed timeline into a zero-ms result.
    if (deviceEvents.has(from) !== deviceEvents.has(to)) return null;
    return start !== undefined && end !== undefined && Number.isFinite(start)
      && Number.isFinite(end) && end >= start ? end - start : null;
  };

  return {
    userSpeechEndToGeminiFirstMessageMs: delta('USER_SPEECH_ENDED', 'GEMINI_FIRST_MESSAGE'),
    userSpeechEndToGeminiTurnCommitMs: delta('USER_SPEECH_ENDED', 'GEMINI_TURN_COMMITTED'),
    userSpeechEndToGeminiFirstAudioMs: delta('USER_SPEECH_ENDED', 'GEMINI_FIRST_AUDIO_RECEIVED'),
    geminiFirstAudioToResampleStartMs: delta('GEMINI_FIRST_AUDIO_RECEIVED', 'GEMINI_RESAMPLE_STARTED'),
    resampleDurationMs: delta('GEMINI_RESAMPLE_STARTED', 'GEMINI_RESAMPLE_ENDED'),
    geminiAudioToBackendPcmSentMs: delta('GEMINI_FIRST_AUDIO_RECEIVED', 'BACKEND_FIRST_PCM_16K_SENT'),
    backendPcmSentToFrontendReceivedMs: delta('BACKEND_FIRST_PCM_16K_SENT', 'FRONTEND_FIRST_PCM_RECEIVED'),
    frontendReceivedToSimliPlayedMs: delta('FRONTEND_FIRST_PCM_RECEIVED', 'SIMLI_FIRST_AUDIO_PLAYED'),
    totalSpeechEndToFirstAudibleResponseMs: delta('USER_SPEECH_ENDED', 'SIMLI_FIRST_AUDIO_PLAYED'),
    geminiTurnCompleteToPlaybackCompleteMs: delta('GEMINI_TURN_COMPLETE', 'AVATAR_AUDIO_PLAYBACK_COMPLETE'),
    playbackCompleteToListeningMs: delta('AVATAR_AUDIO_PLAYBACK_COMPLETE', 'LISTENING_REOPENED'),
  };
}

export function recordLiveTutorVoiceEvent(
  event: LiveTutorVoiceEvent,
  identity: VoiceTelemetryIdentity,
  eventTimestampMs = Date.now(),
  details: Record<string, unknown> = {},
): void {
  const key = keyFor(identity);
  const timeline = timelines.get(key) ?? {};
  if (timeline[event] !== undefined) return;
  timeline[event] = eventTimestampMs;
  timelines.set(key, timeline);

  logger.info('live_tutor_voice_timeline', {
    event,
    eventTimestampMs,
    ...identity,
    ...details,
    metrics: metrics(timeline),
    category: 'live_tutor_voice_latency',
  });
  const currentMetrics = metrics(timeline);
  if (event === 'GEMINI_FIRST_AUDIO_RECEIVED' && currentMetrics.userSpeechEndToGeminiFirstAudioMs !== null) {
    observeLiveTutorVoiceLatency('speech_end_to_gemini_audio', currentMetrics.userSpeechEndToGeminiFirstAudioMs);
  }
  if (event === 'BACKEND_FIRST_PCM_16K_SENT' && currentMetrics.geminiAudioToBackendPcmSentMs !== null) {
    observeLiveTutorVoiceLatency('gemini_audio_to_backend_pcm', currentMetrics.geminiAudioToBackendPcmSentMs);
  }
  if (event === 'FRONTEND_FIRST_PCM_RECEIVED' && currentMetrics.backendPcmSentToFrontendReceivedMs !== null) {
    observeLiveTutorVoiceLatency('backend_pcm_to_frontend', currentMetrics.backendPcmSentToFrontendReceivedMs);
  }
  if (event === 'SIMLI_FIRST_AUDIO_PLAYED') {
    if (currentMetrics.frontendReceivedToSimliPlayedMs !== null) {
      observeLiveTutorVoiceLatency('frontend_pcm_to_simli_playback', currentMetrics.frontendReceivedToSimliPlayedMs);
    }
    if (currentMetrics.totalSpeechEndToFirstAudibleResponseMs !== null) {
      observeLiveTutorVoiceLatency('speech_end_to_first_audible', currentMetrics.totalSpeechEndToFirstAudibleResponseMs);
    }
  }
  if (event === 'AVATAR_AUDIO_PLAYBACK_COMPLETE') {
    const totalLatency = currentMetrics.totalSpeechEndToFirstAudibleResponseMs;
    const samples = totalLatencySamplesBySession.get(identity.sessionId) ?? [];
    if (typeof totalLatency === 'number') samples.push(totalLatency);
    totalLatencySamplesBySession.set(identity.sessionId, samples);
    const sortedSamples = [...samples].sort((left, right) => left - right);
    const middle = Math.floor(sortedSamples.length / 2);
    const medianTotalLatencyMs = sortedSamples.length === 0
      ? null
      : sortedSamples.length % 2 === 0
      ? (sortedSamples[middle - 1] + sortedSamples[middle]) / 2
      : sortedSamples[middle];
    logger.info('live_tutor_latency_summary', {
      ...identity,
      metrics: currentMetrics,
      medianTotalSpeechEndToFirstAudibleResponseMs: medianTotalLatencyMs,
      completedTurnSampleCount: sortedSamples.length,
      category: 'live_tutor_voice_latency',
    });
  }
}

export function clearLiveTutorVoiceTelemetry(sessionId: string): void {
  for (const key of timelines.keys()) {
    if (key.startsWith(`${sessionId}:`)) timelines.delete(key);
  }
  totalLatencySamplesBySession.delete(sessionId);
}
