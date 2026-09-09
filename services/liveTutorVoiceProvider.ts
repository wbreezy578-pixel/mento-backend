import {
  buildLiveTutorSystemInstruction,
  closeGeminiLiveSession,
  createGeminiLiveSession,
  endRealtimePcmAudio,
  getGeminiLiveSession,
  interruptGeminiLiveSession,
  sendRealtimePcmAudio,
  updateLiveTutorLanguage,
  type GeminiLiveSession,
} from './liveTutorGeminiLiveService';
import {
  closeOpenAIRealtimeSession,
  createOpenAIRealtimeSession,
  endOpenAIRealtimePcmAudio,
  getOpenAIRealtimeSession,
  interruptOpenAIRealtimeSession,
  registerOpenAIRealtimeSession,
  sendOpenAIRealtimePcmAudio,
} from './liveTutorOpenAIRealtimeService';

export type { GeminiLiveSession } from './liveTutorGeminiLiveService';
export { buildLiveTutorSystemInstruction };

export const LIVE_TUTOR_VOICE_PROVIDER = process.env.LIVE_TUTOR_VOICE_PROVIDER === 'openai' ? 'openai' : 'gemini';

export const createLiveTutorVoiceSession = async (options: Parameters<typeof createGeminiLiveSession>[0] = {}): Promise<GeminiLiveSession> => {
  if (LIVE_TUTOR_VOICE_PROVIDER === 'openai') {
    const session = await createOpenAIRealtimeSession(options);
    registerOpenAIRealtimeSession(session);
    return session;
  }
  return createGeminiLiveSession(options);
};

export const getLiveTutorVoiceSession = (sessionId: string): GeminiLiveSession | undefined => LIVE_TUTOR_VOICE_PROVIDER === 'openai' ? getOpenAIRealtimeSession(sessionId) : getGeminiLiveSession(sessionId);
export const closeLiveTutorVoiceSession = (sessionId: string, reason?: string): Promise<void> => LIVE_TUTOR_VOICE_PROVIDER === 'openai' ? closeOpenAIRealtimeSession(sessionId) : closeGeminiLiveSession(sessionId, reason);
export const interruptLiveTutorVoiceSession = (sessionId: string): number => LIVE_TUTOR_VOICE_PROVIDER === 'openai' ? interruptOpenAIRealtimeSession(sessionId) : interruptGeminiLiveSession(sessionId);
export const sendLiveTutorPcmAudio = (sessionId: string, pcm: Uint8Array, mimeType?: string): void => LIVE_TUTOR_VOICE_PROVIDER === 'openai' ? sendOpenAIRealtimePcmAudio(sessionId, pcm) : sendRealtimePcmAudio(sessionId, pcm, mimeType);
export const endLiveTutorPcmAudio = (sessionId: string): void => LIVE_TUTOR_VOICE_PROVIDER === 'openai' ? endOpenAIRealtimePcmAudio(sessionId) : endRealtimePcmAudio(sessionId);
export const updateLiveTutorVoiceLanguage = (sessionId: string, language: Parameters<typeof updateLiveTutorLanguage>[1]): void => { if (LIVE_TUTOR_VOICE_PROVIDER === 'gemini') updateLiveTutorLanguage(sessionId, language); };
