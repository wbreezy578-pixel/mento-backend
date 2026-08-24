import logger from '../lib/logger';

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

function metrics(timeline: Timeline) {
  const delta = (from: LiveTutorVoiceEvent, to: LiveTutorVoiceEvent) => {
    const start = timeline[from];
    const end = timeline[to];
    return start !== undefined && end !== undefined ? Math.max(0, end - start) : null;
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
  if (event === 'AVATAR_AUDIO_PLAYBACK_COMPLETE') {
    const totalLatency = metrics(timeline).totalSpeechEndToFirstAudibleResponseMs;
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
      metrics: metrics(timeline),
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
