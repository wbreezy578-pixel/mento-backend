import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { prisma } from '../lib/prisma';
import { completeSimliSessionLifecycle } from './simliService';
import { getUserFromRequest } from '../app/lib/auth';
import {
  closeGeminiLiveSession,
  createGeminiLiveSession,
  interruptGeminiLiveSession,
  sendRealtimePcmAudio,
  type GeminiLiveSession,
} from './liveTutorGeminiLiveService';
import { LIVE_TUTOR_INPUT_MIME_TYPE, normalizePcmForSimli, parsePcmMimeType, SIMLI_PCM_BYTES_PER_SAMPLE, SIMLI_PCM_FRAME_BYTES, SIMLI_PCM_SAMPLE_RATE, splitPcmIntoSimliFrames, validateLiveTutorPcm16 } from './liveTutorAudioProtocol';
import logger from '../lib/logger';
import { acquireVoiceLease, refreshVoiceLease, releaseVoiceLease } from '../lib/realtimeRedis';
import { getLiveTutorConversationContext, persistLiveTutorTurn } from './liveTutorConversationService';
import { DEFAULT_LIVE_TUTOR_VOICE_PROFILE, resolveLiveTutorVoiceProfile } from './liveTutorVoiceProfiles';
import { LIVE_TUTOR_VOICE_EVENTS, recordLiveTutorVoiceEvent, clearLiveTutorVoiceTelemetry, type LiveTutorVoiceEvent } from './liveTutorVoiceTelemetry';

const VOICE_PATH = '/api/live-tutor/voice';
const AUTH_TIMEOUT_MS = 10_000;
const RECONNECT_GRACE_PERIOD_MS = 15_000;
const pendingReconnectFinalizations = new Map<string, ReturnType<typeof setTimeout>>();

type VoiceSessionRuntime = {
  gemini: GeminiLiveSession;
  socketRef: { current: WebSocket | null };
  activeRef: { current: boolean };
  userId: string;
  voiceProfile: string;
  detachedAt: number | null;
  leaseOwnerId: string;
};

const voiceSessionRuntimes = new Map<string, VoiceSessionRuntime>();

export function isVoiceSessionResumable(
  runtime: { gemini: Pick<GeminiLiveSession, 'status'>; detachedAt: number | null },
  now = Date.now(),
): boolean {
  return runtime.gemini.status === 'active'
    && runtime.detachedAt !== null
    && now - runtime.detachedAt <= RECONNECT_GRACE_PERIOD_MS;
}

type VoiceAuthMessage = { type: 'auth'; token: string; streamId: string; voiceTraceId: string; avatarVoiceProfile: string };

function reject(socket: WebSocket, code: string) {
  socket.send(JSON.stringify({ type: 'error', code }));
  socket.close(1008, code);
}

function isVoicePath(request: IncomingMessage) {
  return new URL(request.url ?? '/', 'http://localhost').pathname === VOICE_PATH;
}

async function authenticateVoiceMessage(message: VoiceAuthMessage) {
  if (!message.token || !message.streamId) {
    logger.warn('[LiveTutorVoiceGateway] authentication failed', { reason: 'missing_token_or_stream_id', hasToken: Boolean(message.token), streamId: message.streamId || null, category: 'live_tutor_voice_auth' });
    return null;
  }

  const request = new Request('http://live-tutor-voice.local/api/live-tutor/voice', {
    headers: { Authorization: `Bearer ${message.token}` },
  });
  const user = await getUserFromRequest(request);
  logger.info('[LiveTutorVoiceGateway] token validation result', { valid: Boolean(user), category: 'live_tutor_voice_auth' });
  if (!user) return null;

  const liveTutorSession = await prisma.liveTutorSession.findFirst({
    where: {
      streamId: message.streamId,
      userId: user.id,
      status: { in: ['active', 'reconnecting'] },
      billingFinalized: false,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });
  logger.info('[LiveTutorVoiceGateway] stream ownership result', { userId: user.id, streamId: message.streamId, owned: Boolean(liveTutorSession), category: 'live_tutor_voice_auth' });
  if (!liveTutorSession) return null;
  const voiceProfile = resolveLiveTutorVoiceProfile(message.avatarVoiceProfile);
  const storedVoiceProfile = resolveLiveTutorVoiceProfile(liveTutorSession.avatarVoiceProfile) ?? DEFAULT_LIVE_TUTOR_VOICE_PROFILE;
  if (!voiceProfile || storedVoiceProfile !== voiceProfile) return null;
  return { userId: user.id, streamId: liveTutorSession.streamId, conversationId: liveTutorSession.conversationId, voiceProfile, expiresAt: liveTutorSession.expiresAt };
}

export function attachLiveTutorVoiceGateway(server: HttpServer) {
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    if (!isVoicePath(request)) return;
    logger.info('[LiveTutorVoiceGateway] WebSocket connection received', { path: VOICE_PATH, category: 'live_tutor_voice_connection' });
    webSocketServer.handleUpgrade(request, socket, head, (client) => webSocketServer.emit('connection', client, request));
  });

  webSocketServer.on('connection', (socket: WebSocket) => {
    logger.info('[LiveTutorVoiceServer] voice_ws_connected', { event: 'voice_ws_connected', category: 'live_tutor_voice_connection' });
    let authenticated = false;
    let voiceTraceId: string | null = null;
    let durableUserId: string | null = null;
    let durableStreamId: string | null = null;
    let durableConversationId: string | null = null;
    let closed = false;
    let gemini: GeminiLiveSession | null = null;
    let firstPcmReceived = false;
    let pcmChunksReceived = 0;
    let pcmBytesReceived = 0;
    let geminiConnecting = false;
    let socketRef = { current: socket as WebSocket | null };
    let activeRef = { current: true };
    let realtimeLeaseStreamId: string | null = null;
    let realtimeLeaseOwnerId: string | null = null;
    let realtimeLeaseTimer: ReturnType<typeof setInterval> | null = null;
    let sessionExpiryTimer: ReturnType<typeof setTimeout> | null = null;
    const audioSequenceByGeneration = new Map<number, number>();
    const previousAudioSentAtByGeneration = new Map<number, number>();
    const pendingPcm: Uint8Array[] = [];
    const authTimer = setTimeout(() => reject(socket, 'authentication_timeout'), AUTH_TIMEOUT_MS);

    const cleanup = async (reason: string) => {
      if (closed) return;
      closed = true;
      activeRef.current = false;
      if (socketRef.current === socket) socketRef.current = null;
      clearTimeout(authTimer);
      if (realtimeLeaseTimer) {
        clearInterval(realtimeLeaseTimer);
        realtimeLeaseTimer = null;
      }
      if (sessionExpiryTimer) {
        clearTimeout(sessionExpiryTimer);
        sessionExpiryTimer = null;
      }
      const terminalDisconnect = reason === 'mobile_disconnect' || reason === 'user_ended_session' || reason === 'session_expired';
      const canResume = Boolean(authenticated && gemini && durableStreamId && !terminalDisconnect && gemini.status === 'active');
      if (gemini && !canResume) {
        await closeGeminiLiveSession(gemini.sessionId, reason);
        clearLiveTutorVoiceTelemetry(gemini.sessionId);
        if (durableStreamId) voiceSessionRuntimes.delete(durableStreamId);
      }
      if (!canResume && realtimeLeaseStreamId && realtimeLeaseOwnerId) {
        await releaseVoiceLease(realtimeLeaseStreamId, realtimeLeaseOwnerId).catch((error) => {
          logger.warn('[LiveTutorVoiceGateway] realtime lease release failed', {
            streamId: realtimeLeaseStreamId,
            message: error instanceof Error ? error.message : String(error),
            category: 'live_tutor_realtime_redis',
          });
        });
        realtimeLeaseStreamId = null;
        realtimeLeaseOwnerId = null;
      }
      if (durableStreamId && durableUserId) {
        logger.info('live_tutor_finalize', { voiceTraceId, streamId: durableStreamId, userId: durableUserId, status: 'disconnected', reason, category: 'live_tutor_lifecycle' });
        await prisma.liveTutorSession.updateMany({
          where: { streamId: durableStreamId, userId: durableUserId, status: 'active', billingFinalized: false },
          data: { status: 'reconnecting', lastActivityAt: new Date() },
        }).catch(() => undefined);
        const streamIdForFinalization = durableStreamId;
        const userIdForFinalization = durableUserId;
        if (terminalDisconnect) {
          await completeSimliSessionLifecycle(streamIdForFinalization, {
            status: reason === 'session_expired' || reason === 'user_ended_session' ? 'completed' : 'disconnected',
            reason,
          }, userIdForFinalization).catch(() => undefined);
          logger.info('voice_transport_closed', { voiceTraceId, streamId: durableStreamId, reason, pcmChunksReceived, pcmBytesReceived, category: 'live_tutor_voice_lifecycle' });
          return;
        }
        const leaseOwnerIdForFinalization = realtimeLeaseOwnerId;
        const finalizationTimer = setTimeout(() => {
          pendingReconnectFinalizations.delete(streamIdForFinalization);
          const runtime = voiceSessionRuntimes.get(streamIdForFinalization);
          if (runtime?.gemini) {
            void closeGeminiLiveSession(runtime.gemini.sessionId, 'Voice WebSocket reconnect grace expired');
            clearLiveTutorVoiceTelemetry(runtime.gemini.sessionId);
          }
          voiceSessionRuntimes.delete(streamIdForFinalization);
          if (leaseOwnerIdForFinalization) {
            void releaseVoiceLease(streamIdForFinalization, leaseOwnerIdForFinalization).catch(() => undefined);
          }
          void completeSimliSessionLifecycle(streamIdForFinalization, { status: 'disconnected', reason: `Voice WebSocket reconnect grace expired: ${reason}` }, userIdForFinalization).catch(() => undefined);
        }, RECONNECT_GRACE_PERIOD_MS);
        pendingReconnectFinalizations.set(streamIdForFinalization, finalizationTimer);
        if (canResume && gemini && durableStreamId) {
          const runtime = voiceSessionRuntimes.get(durableStreamId);
          if (runtime) runtime.detachedAt = Date.now();
        }
      }
      logger.info('voice_transport_closed', { voiceTraceId, streamId: durableStreamId, reason, pcmChunksReceived, pcmBytesReceived, category: 'live_tutor_voice_lifecycle' });
      logger.info('[LiveTutorVoiceServer] close', { voiceTraceId, reason, pcmChunksReceived, pcmBytesReceived, category: 'live_tutor_voice_closed' });
    };

    socket.on('message', async (payload, isBinary) => {
      try {
        if (!authenticated) {
          if (isBinary) {
            logger.warn('[LiveTutorVoiceGateway] authentication failed', { reason: 'binary_before_auth', category: 'live_tutor_voice_auth' });
            return reject(socket, 'authentication_required');
          }
          const message = JSON.parse(payload.toString()) as Partial<VoiceAuthMessage>;
          voiceTraceId = typeof message.voiceTraceId === 'string' ? message.voiceTraceId : null;
          logger.info('[LiveTutorVoiceServer] auth_received', { voiceTraceId, category: 'live_tutor_voice_auth' });
          if (message.type !== 'auth' || typeof message.token !== 'string' || typeof message.streamId !== 'string' || typeof message.voiceTraceId !== 'string' || typeof message.avatarVoiceProfile !== 'string') return reject(socket, 'invalid_auth_message');
          const identity = await authenticateVoiceMessage(message as VoiceAuthMessage);
          if (!identity) return reject(socket, 'unauthorized');
          const resumableRuntime = voiceSessionRuntimes.get(identity.streamId);
          const canResumeRuntime = Boolean(
            resumableRuntime
            && resumableRuntime.userId === identity.userId
            && resumableRuntime.voiceProfile === identity.voiceProfile
            && isVoiceSessionResumable(resumableRuntime),
          );
          const leaseOwnerId = canResumeRuntime && resumableRuntime
            ? resumableRuntime.leaseOwnerId
            : `${process.pid}:${randomUUID()}`;
          const leaseAcquired = await acquireVoiceLease(identity.streamId, leaseOwnerId, {
            userId: identity.userId,
            streamId: identity.streamId,
            voiceTraceId: message.voiceTraceId,
          });
          if (!leaseAcquired) return reject(socket, 'voice_session_in_use');
          const pendingFinalization = pendingReconnectFinalizations.get(identity.streamId);
          if (pendingFinalization) {
            clearTimeout(pendingFinalization);
            pendingReconnectFinalizations.delete(identity.streamId);
          }
          await prisma.liveTutorSession.updateMany({
            where: { streamId: identity.streamId, userId: identity.userId, status: 'reconnecting', billingFinalized: false },
            data: { status: 'active', lastActivityAt: new Date() },
          });
          authenticated = true;
          durableUserId = identity.userId;
          durableStreamId = identity.streamId;
          durableConversationId = identity.conversationId;
          realtimeLeaseStreamId = identity.streamId;
          realtimeLeaseOwnerId = leaseOwnerId;
          realtimeLeaseTimer = setInterval(() => {
            if (!realtimeLeaseStreamId || !realtimeLeaseOwnerId || closed) return;
            void refreshVoiceLease(realtimeLeaseStreamId, realtimeLeaseOwnerId, {
              lastHeartbeatAt: new Date().toISOString(),
            }).then((refreshed) => {
              if (!refreshed && socket.readyState === WebSocket.OPEN) {
                reject(socket, 'voice_session_lease_lost');
              }
            }).catch((error) => {
              logger.warn('[LiveTutorVoiceGateway] realtime lease refresh failed', {
                streamId: realtimeLeaseStreamId,
                message: error instanceof Error ? error.message : String(error),
                category: 'live_tutor_realtime_redis',
              });
              if (socket.readyState === WebSocket.OPEN) {
                reject(socket, 'voice_session_lease_unavailable');
              }
            });
          }, 10_000);
          const expiresAtMs = identity.expiresAt?.getTime() ?? Number.NaN;
          if (Number.isFinite(expiresAtMs)) {
            const remainingMs = Math.max(1, expiresAtMs - Date.now());
            sessionExpiryTimer = setTimeout(() => {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'error', code: 'session_expired' }));
                socket.close(1000, 'session_expired');
              }
            }, remainingMs);
          }
          clearTimeout(authTimer);
          logger.info('[LiveTutorVoiceServer] voice_auth_validated', { event: 'voice_auth_validated', voiceTraceId, streamId: identity.streamId, category: 'live_tutor_voice_auth' });
          socket.send(JSON.stringify({ type: 'auth_ok', streamId: identity.streamId }));
          logger.info('[LiveTutorVoiceServer] voice_auth_ok_sent', { event: 'voice_auth_ok_sent', voiceTraceId, streamId: identity.streamId, category: 'live_tutor_voice_auth' });
          if (canResumeRuntime && resumableRuntime) {
            gemini = resumableRuntime.gemini;
            socketRef = resumableRuntime.socketRef;
            activeRef = resumableRuntime.activeRef;
            socketRef.current = socket;
            activeRef.current = true;
            resumableRuntime.detachedAt = null;
            logger.info('[LiveTutorVoiceServer] voice_session_resumed', {
              voiceTraceId,
              streamId: identity.streamId,
              sessionId: gemini.sessionId,
              category: 'live_tutor_voice_reconnect',
            });
            socket.send(JSON.stringify({ type: 'connected', sessionId: gemini.sessionId, resumed: true }));
            return;
          }
          geminiConnecting = true;
          gemini = await createGeminiLiveSession({
            userId: identity.userId,
            streamId: identity.streamId,
            conversationContext: (await getLiveTutorConversationContext(identity.conversationId, identity.userId)) ?? undefined,
            voiceTraceId: voiceTraceId ?? message.voiceTraceId,
            voiceProfile: identity.voiceProfile,
            onTurnComplete: (turn) => {
              if (!durableConversationId) return;
              persistLiveTutorTurn({
                conversationId: durableConversationId,
                userId: identity.userId,
                sessionId: gemini?.sessionId ?? voiceTraceId ?? 'unknown',
                turnNumber: turn.turnNumber,
                userText: turn.userText,
                assistantText: turn.assistantText,
              });
            },
            onInterrupted: () => {
              logger.info('[LiveTutorVoice] Gemini interruption', { category: 'live_tutor_voice_interrupted' });
              if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: 'interrupted' }));
            },
            onError: (error) => {
              logger.error('[LiveTutorVoiceServer] error', { voiceTraceId, stage: 'gemini', message: error.message, category: 'live_tutor_voice_error' });
              void completeSimliSessionLifecycle(identity.streamId, { status: 'failed', reason: error.message }, identity.userId)
                .catch(() => undefined)
                .finally(() => {
                  if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.close(1011, 'gemini_error');
                });
            },
            onResponseStarted: (turnNumber, generationId) => {
              if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: 'response_started', turnNumber, generationId }));
            },
            onResponseCompleted: (turnNumber, generationId) => {
              if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: 'response_completed', turnNumber, generationId }));
            },
            onTranscript: ({ speaker, text, isFinal, turnNumber, generationId }) => {
              if (socketRef.current?.readyState === WebSocket.OPEN && text.trim()) {
                socketRef.current.send(JSON.stringify({ type: 'transcript', speaker, text, isFinal, turnNumber, generationId }));
              }
            },
            onAudioChunk: async (data, mimeType, _timestamp, generationId) => {
              const activeGenerationId = gemini?.generationId ?? 0;
              const isStale = generationId !== activeGenerationId
                || gemini?.completedGenerationId === generationId
                || gemini?.discardProviderOutput === true
                || gemini?.status !== 'active';
              if (isStale) {
                logger.info('live_tutor_audio_stale_discarded', {
                  sessionId: gemini?.sessionId ?? null,
                  streamId: durableStreamId,
                  turnId: `${durableStreamId ?? 'unknown'}-turn-${gemini?.turnNumber ?? 0}`,
                  previousState: 'speaking',
                  resultingState: 'interrupted',
                  reason: generationId !== activeGenerationId
                    ? 'generation_mismatch'
                    : gemini?.completedGenerationId === generationId
                    ? 'completed_generation'
                    : gemini?.discardProviderOutput
                    ? 'discard_provider_output'
                    : 'session_inactive',
                  generationId,
                  activeGenerationId,
                  inputMimeType: mimeType,
                  byteLength: data.byteLength,
                  category: 'live_tutor_voice_audio_path',
                });
                return;
              }

              const format = parsePcmMimeType(mimeType);
              const nextSequenceNumber = (audioSequenceByGeneration.get(generationId) ?? 0) + 1;
              const shouldSampleProviderChunk = nextSequenceNumber === 1 || nextSequenceNumber % 50 === 0;
              const resampleStartedAt = Date.now();
              recordLiveTutorVoiceEvent('GEMINI_RESAMPLE_STARTED', {
                sessionId: gemini?.sessionId ?? 'unknown',
                streamId: durableStreamId,
                voiceTraceId,
                turnNumber: gemini?.turnNumber ?? 0,
                generationId,
              }, resampleStartedAt, { inputMimeType: mimeType, inputByteLength: data.byteLength });
              if (shouldSampleProviderChunk) logger.info('[LiveTutorVoiceGateway] pcm_resample_sample', {
                sessionId: gemini?.sessionId ?? null,
                streamId: durableStreamId,
                turnNumber: gemini?.turnNumber ?? 0,
                generationId,
                inputMimeType: mimeType,
                inputByteLength: data.byteLength,
                outputMimeType: 'audio/pcm;rate=16000',
                category: 'live_tutor_voice_audio_path',
              });

              const simliAudio = normalizePcmForSimli(data, mimeType);
              const resampleEndedAt = Date.now();
              recordLiveTutorVoiceEvent('GEMINI_RESAMPLE_ENDED', {
                sessionId: gemini?.sessionId ?? 'unknown',
                streamId: durableStreamId,
                voiceTraceId,
                turnNumber: gemini?.turnNumber ?? 0,
                generationId,
              }, resampleEndedAt, { outputMimeType: 'audio/pcm;rate=16000', outputByteLength: simliAudio.byteLength });
              const simliMimeType = 'audio/pcm;rate=16000';
              if (shouldSampleProviderChunk) logger.info('live_tutor_audio_format_sample', {
                sessionId: gemini?.sessionId ?? null,
                streamId: durableStreamId,
                generationId,
                turnNumber: gemini?.turnNumber ?? 0,
                sourceMimeType: mimeType,
                sourceSampleRate: format.sampleRate,
                sourceChannels: format.channels,
                outputMimeType: simliMimeType,
                outputSampleRate: SIMLI_PCM_SAMPLE_RATE,
                outputChannels: 1,
                outputByteLength: simliAudio.byteLength,
                resampleLatencyMs: Date.now() - resampleStartedAt,
                audioDurationMs: (simliAudio.byteLength / SIMLI_PCM_BYTES_PER_SAMPLE / SIMLI_PCM_SAMPLE_RATE) * 1000,
                outputFrameBytes: SIMLI_PCM_FRAME_BYTES,
                category: 'live_tutor_audio_format',
              });

              if (activeRef.current && socketRef.current?.readyState === WebSocket.OPEN) {
                try {
                  for (const frame of splitPcmIntoSimliFrames(simliAudio)) {
                    if (!activeRef.current || socketRef.current?.readyState !== WebSocket.OPEN) break;
                    const sequenceNumber = (audioSequenceByGeneration.get(generationId) ?? 0) + 1;
                    audioSequenceByGeneration.set(generationId, sequenceNumber);
                    const backendPcmSentAt = Date.now();
                    const previousAudioSentAt = previousAudioSentAtByGeneration.get(generationId);
                    previousAudioSentAtByGeneration.set(generationId, backendPcmSentAt);
                    const audioDurationMs = (frame.byteLength / SIMLI_PCM_BYTES_PER_SAMPLE / SIMLI_PCM_SAMPLE_RATE) * 1_000;
                    socketRef.current.send(JSON.stringify({
                      type: 'audio_chunk',
                      sessionId: gemini?.sessionId ?? null,
                      streamId: durableStreamId,
                      mimeType: simliMimeType,
                      turnNumber: gemini?.turnNumber ?? 0,
                      generationId,
                      sequenceNumber,
                      byteLength: frame.byteLength,
                      audioDurationMs,
                      geminiAudioReceivedAt: _timestamp,
                      backendPcmSentAt,
                      millisecondsSincePreviousAudioChunk: previousAudioSentAt === undefined ? null : backendPcmSentAt - previousAudioSentAt,
                    }));
                    socketRef.current.send(frame, { binary: true });
                    const shouldSampleAudioLog = sequenceNumber === 1 || sequenceNumber % 50 === 0;
                    recordLiveTutorVoiceEvent('BACKEND_FIRST_PCM_16K_SENT', {
                      sessionId: gemini?.sessionId ?? 'unknown',
                      streamId: durableStreamId,
                      voiceTraceId,
                      turnNumber: gemini?.turnNumber ?? 0,
                      generationId,
                    }, backendPcmSentAt, { mimeType: simliMimeType, byteLength: frame.byteLength, sequenceNumber, audioDurationMs });
                    if (shouldSampleAudioLog) logger.info('[LiveTutorVoiceGateway] output_pcm_delivery_sample', {
                      sessionId: gemini?.sessionId ?? null,
                      streamId: durableStreamId,
                      turnNumber: gemini?.turnNumber ?? 0,
                      generationId,
                      mimeType: simliMimeType,
                      byteLength: frame.byteLength,
                      sequenceNumber,
                      category: 'live_tutor_voice_audio_path',
                    });
                  }
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  logger.error('[LiveTutorVoiceGateway] output_pcm_send_failed', {
                    sessionId: gemini?.sessionId ?? null,
                    streamId: durableStreamId,
                    turnNumber: gemini?.turnNumber ?? 0,
                    generationId,
                    mimeType: simliMimeType,
                    byteLength: simliAudio.byteLength,
                    error: message,
                    category: 'live_tutor_voice_audio_path',
                  });
                }
              }
            },
          });
          geminiConnecting = false;
          voiceSessionRuntimes.set(identity.streamId, {
            gemini,
            socketRef,
            activeRef,
            userId: identity.userId,
            voiceProfile: identity.voiceProfile,
            detachedAt: null,
            leaseOwnerId,
          });
          for (const pendingAudio of pendingPcm.splice(0)) {
            sendRealtimePcmAudio(gemini.sessionId, pendingAudio, LIVE_TUTOR_INPUT_MIME_TYPE);
          }
          socket.send(JSON.stringify({ type: 'connected', sessionId: gemini.sessionId }));
          return;
        }

        if (!isBinary) {
          const message = JSON.parse(payload.toString()) as { type?: string; token?: string; streamId?: string; event?: string; eventTimestampMs?: number; turnNumber?: number; generationId?: number; details?: Record<string, unknown> };
          logger.info('[LiveTutorVoiceBackend] message received', { type: message.type ?? 'unknown', category: 'live_tutor_voice_message' });
          if (message.type === 'auth_refresh') {
            if (!message.token || message.streamId !== durableStreamId || !durableUserId) {
              return reject(socket, 'invalid_auth_refresh');
            }
            const refreshRequest = new Request('http://live-tutor-voice.local/api/live-tutor/voice', {
              headers: { Authorization: `Bearer ${message.token}` },
            });
            const refreshedUser = await getUserFromRequest(refreshRequest);
            if (!refreshedUser || refreshedUser.id !== durableUserId) {
              return reject(socket, 'unauthorized_auth_refresh');
            }
            socket.send(JSON.stringify({ type: 'auth_refreshed' }));
            return;
          }
          if (message.type === 'telemetry' && gemini && LIVE_TUTOR_VOICE_EVENTS.includes(message.event as LiveTutorVoiceEvent)) {
            if (realtimeLeaseStreamId && realtimeLeaseOwnerId) {
              void refreshVoiceLease(realtimeLeaseStreamId, realtimeLeaseOwnerId, {
                lastTelemetryAt: new Date().toISOString(),
              });
            }
            const turnNumber = Number.isInteger(message.turnNumber) ? message.turnNumber! : gemini.turnNumber;
            const generationId = Number.isInteger(message.generationId) ? message.generationId! : gemini.generationId;
            recordLiveTutorVoiceEvent(message.event as LiveTutorVoiceEvent, {
              sessionId: gemini.sessionId,
              streamId: durableStreamId,
              voiceTraceId,
              turnNumber,
              generationId,
            }, typeof message.eventTimestampMs === 'number' ? message.eventTimestampMs : Date.now(), {
              clientTelemetryReceivedAtMs: Date.now(),
              ...(message.details ?? {}),
            });
            if (message.event === 'USER_AUDIO_LAST_CHUNK_SENT') {
              recordLiveTutorVoiceEvent('GEMINI_TURN_COMMITTED', {
                sessionId: gemini.sessionId,
                streamId: durableStreamId,
                voiceTraceId,
                turnNumber,
                generationId,
              }, typeof message.eventTimestampMs === 'number' ? message.eventTimestampMs : Date.now(), {
                reason: 'last_user_pcm_chunk_sent',
              });
            }
            return;
          }
          if (message.type === 'interrupt') {
            const generationId = gemini ? interruptGeminiLiveSession(gemini.sessionId) : 0;
            logger.info('live_tutor_barge_in_detected', {
              streamId: durableStreamId,
              turnId: `${durableStreamId ?? 'unknown'}-turn-${gemini?.turnNumber ?? 0}`,
              previousState: 'speaking',
              resultingState: 'interrupted',
              reason: 'user_speech_activity',
              generationId,
            });
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'interrupted', generationId }));
          }
          return;
        }

        const audio = new Uint8Array(payload as Buffer);
        pcmChunksReceived += 1;
        pcmBytesReceived += audio.byteLength;
        if (pcmChunksReceived === 1 || pcmChunksReceived % 50 === 0) logger.info('[LiveTutorVoiceServer] pcm_received', { voiceTraceId, bytes: audio.byteLength, pcmChunks: pcmChunksReceived, pcmBytes: pcmBytesReceived, category: 'live_tutor_voice_pcm' });
        if (!firstPcmReceived) {
          firstPcmReceived = true;
          logger.info('[LiveTutorVoiceServer] first_pcm_received', { event: 'first_pcm_received', voiceTraceId, bytes: audio.byteLength, pcmChunks: pcmChunksReceived, pcmBytes: pcmBytesReceived, category: 'live_tutor_voice_pcm' });
        }
        try {
          validateLiveTutorPcm16(audio);
        } catch {
          return reject(socket, 'invalid_pcm');
        }
        if (!gemini) {
          if (pendingPcm.length < 8) pendingPcm.push(audio);
          return;
        }
        sendRealtimePcmAudio(gemini.sessionId, audio, LIVE_TUTOR_INPUT_MIME_TYPE);
      } catch (error) {
        logger.error('[LiveTutorVoiceServer] error', { voiceTraceId, stage: geminiConnecting ? 'gemini_connect' : 'message', error: error instanceof Error ? error.message : String(error), category: 'live_tutor_voice_error' });
        reject(socket, 'voice_transport_error');
      }
    });
    socket.on('close', (code, reason) => {
      const closeReason = reason.toString();
      logger.info('[LiveTutorVoiceServer] close', { voiceTraceId, code, reason: closeReason || 'none', pcmChunksReceived, pcmBytesReceived, category: 'live_tutor_voice_connection' });
      void cleanup(closeReason || `websocket_close_${code}`);
    });
    socket.on('error', (error) => {
      logger.error('[LiveTutorVoiceServer] error', { voiceTraceId, stage: 'websocket', message: error.message, pcmChunksReceived, pcmBytesReceived, category: 'live_tutor_voice_error' });
      void cleanup('socket_error');
    });
  });

  return async (): Promise<void> => {
    await Promise.all([...webSocketServer.clients].map((client) => new Promise<void>((resolve) => {
      if (client.readyState === WebSocket.CLOSED) return resolve();
      const forceCloseTimer = setTimeout(() => {
        client.terminate();
        resolve();
      }, 2_000);
      (forceCloseTimer as unknown as NodeJS.Timeout).unref();
      client.once('close', () => {
        clearTimeout(forceCloseTimer);
        resolve();
      });
      client.close(1001, 'server_shutdown');
    })));
    await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
  };
}
