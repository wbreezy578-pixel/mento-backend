import type { GeminiLiveSession } from './liveTutorGeminiLiveService';
import {
  closeOpenAIRealtimeSession,
  createOpenAIRealtimeSession,
  endOpenAIRealtimePcmAudio,
  getOpenAIRealtimeSession,
  interruptOpenAIRealtimeSession,
  registerOpenAIRealtimeSession,
  sendOpenAIRealtimePcmAudio,
  validateOpenAIRealtimeHandshake,
} from './liveTutorOpenAIRealtimeService';

export type { GeminiLiveSession } from './liveTutorGeminiLiveService';
export { buildLiveTutorSystemInstruction } from './liveTutorGeminiLiveService';

export const LIVE_TUTOR_VOICE_PROVIDER = 'openai';

export const createLiveTutorVoiceSession = async (options: Parameters<typeof createOpenAIRealtimeSession>[0] = {}): Promise<GeminiLiveSession> => {
  const session = await createOpenAIRealtimeSession(options);
  registerOpenAIRealtimeSession(session);
  return session;
};

export const getLiveTutorVoiceSession = (sessionId: string): GeminiLiveSession | undefined => getOpenAIRealtimeSession(sessionId);
export const closeLiveTutorVoiceSession = (sessionId: string, _reason?: string): Promise<void> => closeOpenAIRealtimeSession(sessionId);
export const interruptLiveTutorVoiceSession = (sessionId: string): number => interruptOpenAIRealtimeSession(sessionId);
export const sendLiveTutorPcmAudio = (sessionId: string, pcm: Uint8Array, _mimeType?: string): void => sendOpenAIRealtimePcmAudio(sessionId, pcm);
export const endLiveTutorPcmAudio = (sessionId: string): void => endOpenAIRealtimePcmAudio(sessionId);
export const updateLiveTutorVoiceLanguage = (_sessionId: string, _language?: unknown): void => {
  // No-op: Live Tutor is now OpenAI-only and does not use Gemini Live session language updates.
};
export const validateLiveTutorVoiceProviderHandshake = (): Promise<void> => validateOpenAIRealtimeHandshake();
