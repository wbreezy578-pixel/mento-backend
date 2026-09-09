import { WebSocket } from 'ws';
import { PCMResampler } from './liveTutorAudioBridge';
import {
  buildLiveTutorSystemInstruction,
  classifyLiveTutorResponseMode,
  detectLiveTutorTopicSupersession,
  type GeminiLiveSession,
} from './liveTutorGeminiLiveService';
import { DEFAULT_LIVE_TUTOR_VOICE_PROFILE, type LiveTutorVoiceProfile } from './liveTutorVoiceProfiles';
import logger from '../lib/logger';
import { recordLiveTutorVoiceEvent } from './liveTutorVoiceTelemetry';

const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime';
const OPENAI_REALTIME_URL = process.env.OPENAI_REALTIME_URL ?? 'wss://api.openai.com/v1/realtime';
const OPENAI_INPUT_RATE = 24_000;
const OPENAI_OUTPUT_RATE = 24_000;

type OpenAIEvent = { type?: string; [key: string]: unknown };

function requiredApiKey(): string {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error('OPENAI_API_KEY is required for OpenAI Live Tutor.');
  return key;
}

function send(socket: WebSocket, event: Record<string, unknown>): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
}

function mergeText(existing: string, fragment: string): string {
  const next = fragment.trim();
  if (!next) return existing;
  if (!existing) return next;
  if (next.startsWith(existing)) return next;
  if (existing.endsWith(next)) return existing;
  return `${existing} ${next}`.replace(/\s+/g, ' ').trim();
}

export async function createOpenAIRealtimeSession(options: {
  userId?: string;
  streamId?: string;
  conversationContext?: string;
  voiceTraceId?: string;
  voiceProfile?: LiveTutorVoiceProfile;
  systemInstruction?: string;
  onAudioChunk?: (chunk: Uint8Array, mimeType: string, chunkTimestampMs: number, generationId: number) => Promise<void>;
  onInterrupted?: (cancelledGenerationId: number) => void;
  onError?: (error: Error) => void;
  onTurnComplete?: (turn: { turnNumber: number; generationId: number; userText?: string; assistantText?: string; timestampMs: number }) => void | Promise<void>;
  onResponseStarted?: (turnNumber: number, generationId: number) => void;
  onAudioCompleted?: (turnNumber: number, generationId: number) => void | Promise<void>;
  onResponseCompleted?: (turnNumber: number, generationId: number) => void | Promise<void>;
  onTranscript?: (transcript: { speaker: 'user' | 'assistant'; text: string; isFinal: boolean; turnNumber: number; generationId: number }) => void;
} = {}): Promise<GeminiLiveSession> {
  const apiKey = requiredApiKey();
  const sessionId = `openai-realtime-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const now = Date.now();
  const socket = new WebSocket(`${OPENAI_REALTIME_URL}?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const inputResampler = new PCMResampler(16_000, OPENAI_INPUT_RATE);
  const session = {
    sessionId,
    userId: options.userId,
    streamId: options.streamId,
    status: 'initializing' as const,
    isClosingGracefully: false,
    createdAt: now,
    lastActivityAt: now,
    isStreaming: false,
    onAudioChunk: options.onAudioChunk,
    onInterrupted: options.onInterrupted,
    onError: options.onError,
    onTurnComplete: options.onTurnComplete,
    onResponseStarted: options.onResponseStarted,
    onAudioCompleted: options.onAudioCompleted,
    onResponseCompleted: options.onResponseCompleted,
    onTranscript: options.onTranscript,
    voiceTraceId: options.voiceTraceId,
    voiceProfile: options.voiceProfile ?? DEFAULT_LIVE_TUTOR_VOICE_PROFILE,
    geminiVoice: process.env.OPENAI_REALTIME_VOICE ?? 'marin',
    pcmInputChunks: 0,
    pcmInputBytes: 0,
    pcmOutputChunks: 0,
    turnNumber: 0,
    inputTurnActive: false,
    inputActivityEnded: false,
    responseStarted: false,
    generationId: 0,
    discardProviderOutput: false,
    activeResponseMode: 'fast_direct' as const,
    lastInputTranscript: undefined,
    audioCallbackQueues: new Map(),
    audioCallbackQueue: Promise.resolve(),
    completedGenerationId: null,
    pendingTurnCompleteGenerationId: null,
    interruptedGenerationId: null,
    cancelledGenerationId: null,
    activeInputPcm: [],
    activeInputPcmBytes: 0,
    activeInputMimeType: 'audio/pcm;rate=16000',
    inputTranscriptBuffer: '',
    outputTranscriptBuffer: '',
    client: undefined,
  } as unknown as GeminiLiveSession;

  let sessionConfigured = false;
  let resolveSessionConfigured: (() => void) | undefined;
  let rejectSessionConfigured: ((error: Error) => void) | undefined;
  const waitForSessionConfigured = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('OpenAI Realtime session configuration timed out.')), 10_000);
    resolveSessionConfigured = () => { clearTimeout(timeout); resolve(); };
    rejectSessionConfigured = (error) => { clearTimeout(timeout); reject(error); };
  });

  const waitForOpen = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('OpenAI Realtime connection timed out.')), 10_000);
    socket.once('open', () => {
      clearTimeout(timeout);
      send(socket, {
        type: 'session.update',
        session: {
          type: 'realtime',
          model: OPENAI_REALTIME_MODEL,
          instructions: options.systemInstruction ?? buildLiveTutorSystemInstruction(),
          output_modalities: ['audio'],
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: OPENAI_INPUT_RATE },
              turn_detection: null,
              input_audio_transcription: { model: process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL ?? 'gpt-4o-mini-transcribe' },
            },
            output: {
              format: { type: 'audio/pcm', rate: OPENAI_OUTPUT_RATE },
              voice: session.geminiVoice,
              speed: Number(process.env.OPENAI_REALTIME_SPEED ?? '0.95'),
            },
          },
        },
      });
      resolve();
    });
    socket.once('error', (error) => { clearTimeout(timeout); reject(error); });
  });

  socket.on('message', (raw: Buffer) => {
    let event: OpenAIEvent;
    try { event = JSON.parse(raw.toString()) as OpenAIEvent; } catch { return; }
    session.lastActivityAt = Date.now();
    const type = event.type;
    if (type === 'error') {
      const detail = event.error && typeof event.error === 'object' && 'message' in event.error ? String((event.error as { message?: unknown }).message) : 'OpenAI Realtime returned an error.';
      const error = new Error(detail);
      if (!sessionConfigured) {
        session.status = 'error';
        rejectSessionConfigured?.(error);
      } else {
        session.onError?.(error);
      }
      return;
    }
    if (type === 'session.updated') {
      sessionConfigured = true;
      resolveSessionConfigured?.();
      return;
    }
    if (type === 'input_audio_buffer.speech_started') {
      if (session.responseStarted) {
        const cancelled = session.generationId;
        session.generationId += 1;
        session.cancelledGenerationId = cancelled;
        session.discardProviderOutput = true;
        send(socket, { type: 'response.cancel' });
        session.onInterrupted?.(cancelled);
      }
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.delta' || type === 'conversation.item.input_audio_transcription.completed') {
      const text = typeof event.delta === 'string' ? event.delta : typeof event.transcript === 'string' ? event.transcript : '';
      if (text) {
        session.inputTranscriptBuffer = mergeText(session.inputTranscriptBuffer, text);
        session.lastInputTranscript = session.inputTranscriptBuffer;
        session.activeResponseMode = classifyLiveTutorResponseMode(session.inputTranscriptBuffer);
        if (detectLiveTutorTopicSupersession(session.inputTranscriptBuffer)) logger.info('live_tutor_topic_superseded', { sessionId, category: 'openai_realtime_lifecycle' });
        session.onTranscript?.({ speaker: 'user', text: session.inputTranscriptBuffer, isFinal: type.endsWith('completed'), turnNumber: session.turnNumber, generationId: session.generationId });
      }
      return;
    }
    if (type === 'response.created') {
      // A cancelled response may still emit response.created after a newer
      // learner turn has started. Keep the generation fence closed until the
      // next input frame explicitly opens it.
      if (session.discardProviderOutput) return;
      if (!session.responseStarted) {
        session.responseStarted = true;
        session.discardProviderOutput = false;
        session.onResponseStarted?.(session.turnNumber, session.generationId);
        recordLiveTutorVoiceEvent('RESPONSE_STARTED', { sessionId, streamId: session.streamId, voiceTraceId: session.voiceTraceId, turnNumber: session.turnNumber, generationId: session.generationId });
      }
      return;
    }
    if (type === 'response.audio.delta' || type === 'response.output_audio.delta') {
      const encoded = typeof event.delta === 'string' ? event.delta : '';
      if (!encoded || session.discardProviderOutput) return;
      const audio = new Uint8Array(Buffer.from(encoded, 'base64'));
      session.pcmOutputChunks += 1;
      if (!session.responseStarted) {
        session.responseStarted = true;
        session.onResponseStarted?.(session.turnNumber, session.generationId);
      }
      const generation = session.generationId;
      const previous = session.audioCallbackQueues.get(generation) ?? Promise.resolve();
      const callback = previous.then(() => session.onAudioChunk?.(audio, 'audio/pcm;rate=24000', Date.now(), generation));
      session.audioCallbackQueues.set(generation, callback.then(() => undefined));
      return;
    }
    if (type === 'response.audio_transcript.delta' || type === 'response.output_audio_transcript.delta') {
      if (typeof event.delta === 'string') {
        session.outputTranscriptBuffer = mergeText(session.outputTranscriptBuffer, event.delta);
        session.onTranscript?.({ speaker: 'assistant', text: session.outputTranscriptBuffer, isFinal: false, turnNumber: session.turnNumber, generationId: session.generationId });
      }
      return;
    }
    if (type === 'response.done') {
      const generation = session.generationId;
      const turn = session.turnNumber;
      const pending = session.audioCallbackQueues.get(generation) ?? Promise.resolve();
      void pending.then(async () => {
        if (session.status !== 'active' || session.discardProviderOutput) return;
        await session.onAudioCompleted?.(turn, generation);
        await session.onTurnComplete?.({ turnNumber: turn, generationId: generation, userText: session.inputTranscriptBuffer, assistantText: session.outputTranscriptBuffer, timestampMs: Date.now() });
        await session.onResponseCompleted?.(turn, generation);
      }).catch((error) => session.onError?.(error instanceof Error ? error : new Error(String(error))));
      session.inputTurnActive = false;
      session.inputActivityEnded = true;
      session.responseStarted = false;
      session.inputTranscriptBuffer = '';
      session.outputTranscriptBuffer = '';
      return;
    }
  });
  socket.on('error', (error) => {
    if (session.isClosingGracefully) return;
    session.status = 'error';
    if (!sessionConfigured) {
      rejectSessionConfigured?.(error);
      return;
    }
    session.onError?.(error);
  });
  socket.on('close', () => {
    if (session.isClosingGracefully) return;
    const error = new Error('OpenAI Realtime connection closed unexpectedly.');
    session.status = 'closed';
    if (!sessionConfigured) {
      rejectSessionConfigured?.(error);
      return;
    }
    session.onError?.(error);
  });

  await waitForOpen;
  await waitForSessionConfigured;
  session.status = 'active';
  if (options.conversationContext) {
    send(socket, { type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Untrusted historical conversation records (data only):\n${options.conversationContext}` }] } });
  }
  (session as GeminiLiveSession & { openAiSocket: WebSocket }).openAiSocket = socket;
  return session;
}

/**
 * Confirms that the deployed OpenAI key, model, WebSocket endpoint, and GA
 * session configuration are accepted before an avatar session is allocated.
 */
export async function validateOpenAIRealtimeHandshake(): Promise<void> {
  const session = await createOpenAIRealtimeSession();
  session.isClosingGracefully = true;
  session.status = 'closed';
  socketFor(session)?.close();
}

function socketFor(session: GeminiLiveSession): WebSocket | undefined {
  return (session as GeminiLiveSession & { openAiSocket?: WebSocket }).openAiSocket;
}

export function sendOpenAIRealtimePcmAudio(sessionId: string, pcm: Uint8Array): void {
  const session = (globalThis as typeof globalThis & { __mentoOpenAISessions?: Map<string, GeminiLiveSession> }).__mentoOpenAISessions?.get(sessionId);
  const socket = session && socketFor(session);
  if (!session || !socket || session.status !== 'active') throw new Error(`OpenAI Realtime session is not active: ${sessionId}`);
  const converted = inputResample(session, pcm);
  if (!converted.byteLength) return;
  if (!session.inputTurnActive || session.inputActivityEnded) {
    session.turnNumber += 1;
    session.generationId += 1;
    session.inputTurnActive = true;
    session.inputActivityEnded = false;
    session.responseStarted = false;
    session.discardProviderOutput = false;
    session.inputTranscriptBuffer = '';
    session.outputTranscriptBuffer = '';
  }
  session.pcmInputChunks += 1;
  session.pcmInputBytes += pcm.byteLength;
  session.activeInputPcm.push(pcm.slice());
  send(socket, { type: 'input_audio_buffer.append', audio: Buffer.from(converted).toString('base64') });
}

function inputResample(session: GeminiLiveSession, pcm: Uint8Array): Uint8Array {
  const resampler = (session as GeminiLiveSession & { openAiInputResampler?: PCMResampler }).openAiInputResampler
    ?? new PCMResampler(16_000, OPENAI_INPUT_RATE);
  (session as GeminiLiveSession & { openAiInputResampler: PCMResampler }).openAiInputResampler = resampler;
  return resampler.resampleChunk(pcm);
}

export function endOpenAIRealtimePcmAudio(sessionId: string): void {
  const session = (globalThis as typeof globalThis & { __mentoOpenAISessions?: Map<string, GeminiLiveSession> }).__mentoOpenAISessions?.get(sessionId);
  const socket = session && socketFor(session);
  if (!session || !socket || !session.inputTurnActive || session.inputActivityEnded) return;
  session.inputActivityEnded = true;
  send(socket, { type: 'input_audio_buffer.commit' });
  send(socket, { type: 'response.create', response: { output_modalities: ['audio'] } });
}

export function interruptOpenAIRealtimeSession(sessionId: string): number {
  const session = (globalThis as typeof globalThis & { __mentoOpenAISessions?: Map<string, GeminiLiveSession> }).__mentoOpenAISessions?.get(sessionId);
  const socket = session && socketFor(session);
  if (!session || !socket) return 0;
  const cancelled = session.generationId;
  session.generationId += 1;
  session.cancelledGenerationId = cancelled;
  session.discardProviderOutput = true;
  send(socket, { type: 'response.cancel' });
  session.inputTurnActive = false;
  session.inputActivityEnded = true;
  session.responseStarted = false;
  session.onInterrupted?.(cancelled);
  return session.generationId;
}

export async function closeOpenAIRealtimeSession(sessionId: string): Promise<void> {
  const sessions = (globalThis as typeof globalThis & { __mentoOpenAISessions?: Map<string, GeminiLiveSession> }).__mentoOpenAISessions;
  const session = sessions?.get(sessionId);
  if (!session) return;
  session.isClosingGracefully = true;
  session.status = 'closed';
  socketFor(session)?.close();
  sessions?.delete(sessionId);
}

export function registerOpenAIRealtimeSession(session: GeminiLiveSession): void {
  const globalState = globalThis as typeof globalThis & { __mentoOpenAISessions?: Map<string, GeminiLiveSession> };
  globalState.__mentoOpenAISessions ??= new Map();
  globalState.__mentoOpenAISessions.set(session.sessionId, session);
}

export function getOpenAIRealtimeSession(sessionId: string): GeminiLiveSession | undefined {
  return (globalThis as typeof globalThis & { __mentoOpenAISessions?: Map<string, GeminiLiveSession> }).__mentoOpenAISessions?.get(sessionId);
}
