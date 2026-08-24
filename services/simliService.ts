import logger from '../lib/logger';
import { getCircuitBreaker, retryWithBackoff, getClientErrorMessage, getProviderRetryOptions, sanitizeForLogging } from '../lib/resilience';
import { getSimliApiKey, getSimliAvatarId, getSimliVoiceId, getSimliApiBaseUrl } from '../lib/env';
import { finalizeUsage, rollbackUsage } from './billingService';
import { incrementMonitoringFailure, observeMonitoringLatency } from '../lib/monitoring';
import { prisma } from '../lib/prisma';
import { DEFAULT_LIVE_TUTOR_VOICE_PROFILE, type LiveTutorVoiceProfile } from './liveTutorVoiceProfiles';
import '../lib/metrics';

export interface SimliStreamingSession {
  token: any;
  sessionToken: string;
  streamId: string;
  sessionId?: string;
  avatarId?: string;
  avatarVoiceProfile?: LiveTutorVoiceProfile;
  expiresAt?: string;
  connected?: boolean;
  status?: 'active' | 'disconnected' | 'reconnecting' | 'ended';
}

interface SessionRecord extends SimliStreamingSession {
  createdAt: string;
  lastHeartbeatAt?: string;
  lastActivityAt?: string;
  billingRequestId?: string;
  userId?: string;
  secondsReserved?: number;
  secondsConsumed?: number;
  billingFinalized?: boolean;
}

const simliBreaker = getCircuitBreaker('simli', 3, 30000);
const simliProviderOptions = getProviderRetryOptions('simli');

const activeSessions = new Map<string, SessionRecord>();
const LIVE_TUTOR_PROCESS_ID = `live-tutor-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const INACTIVITY_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
const MAX_SESSION_SECONDS = 10 * 60;
const MIN_HEARTBEAT_INTERVAL_MS = 5 * 1000;
export const LIVE_TUTOR_INACTIVITY_TIMEOUT_MS = INACTIVITY_TIMEOUT_MS;
const GENUINELY_ACTIVE_STATUS = 'active';
const RECOVERABLE_STATUSES = ['creating', 'active', 'reconnecting', 'finalizing', 'recovery_required'] as const;
const TERMINAL_STATUSES = ['completed', 'failed', 'disconnected', 'ended'] as const;

function isDurableSessionStale(session: { status: string; lastActivityAt: Date; expiresAt: Date | null }, now = new Date()): boolean {
  return RECOVERABLE_STATUSES.includes(session.status as typeof RECOVERABLE_STATUSES[number])
    && (session.lastActivityAt.getTime() <= now.getTime() - INACTIVITY_TIMEOUT_MS || Boolean(session.expiresAt && session.expiresAt <= now));
}

function isGenuinelyActiveSession(session: { status: string; lastActivityAt: Date; expiresAt: Date | null }, now = new Date()): boolean {
  return session.status === GENUINELY_ACTIVE_STATUS && !isDurableSessionStale(session, now);
}

function isFreshClaimInProgress(session: { status: string; lastActivityAt: Date; expiresAt: Date | null }, now = new Date()): boolean {
  return ['creating', 'reconnecting'].includes(session.status) && !isDurableSessionStale(session, now);
}

function isTerminalSession(status: string): boolean {
  return TERMINAL_STATUSES.includes(status as typeof TERMINAL_STATUSES[number]);
}

function logStatusTransition(input: { streamId: string; sessionId?: string; userId: string; previousStatus: string; resultingStatus: string; reason: string }) {
  if (input.previousStatus === input.resultingStatus) return;
  logger.info('[LiveTutorLifecycle] status_transition', { ...input, category: 'live_tutor_lifecycle' });
}

function isStaleSession(session: SessionRecord): boolean {
  const now = Date.now();
  const lastHeartbeatAt = session.lastHeartbeatAt ? Date.parse(session.lastHeartbeatAt) : Date.parse(session.createdAt);
  if (!Number.isNaN(lastHeartbeatAt) && now - lastHeartbeatAt > 10 * 60 * 1000) {
    return true;
  }

  if (session.expiresAt) {
    const expiresTs = Date.parse(session.expiresAt);
    if (!Number.isNaN(expiresTs) && expiresTs < now) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if a session has exceeded the inactivity timeout.
 * A session is considered inactive if there has been no activity (consume/heartbeat) for 2 minutes.
 */
function isSessionInactive(session: SessionRecord): boolean {
  const now = Date.now();
  const lastActivityAt = session.lastActivityAt ? Date.parse(session.lastActivityAt) : Date.parse(session.createdAt);
  
  if (Number.isNaN(lastActivityAt)) {
    // If we can't parse the timestamp, assume it's old and inactive
    return true;
  }

  const inactiveMs = now - lastActivityAt;
  return inactiveMs > INACTIVITY_TIMEOUT_MS;
}

function findSessionByUser(userId?: string): SessionRecord | undefined {
  if (!userId) return undefined;
  const sessions = [...activeSessions.values()];
  for (const session of sessions) {
    if (session.userId !== userId) continue;
    const expiresAt = session.expiresAt ? Date.parse(session.expiresAt) : Number.NaN;
    if (session.status !== 'active' || Number.isNaN(expiresAt) || expiresAt <= Date.now() || isStaleSession(session)) {
      removeSession(session.streamId);
      continue;
    }
    return session;
  }
  return undefined;
}

function requireSimliConfig(): { apiKey: string; avatarId: string; voiceId: string } {
  const apiKey = getSimliApiKey();
  const avatarId = getSimliAvatarId();
  const voiceId = getSimliVoiceId();

  if (!apiKey || !avatarId) {
    logger.warn('Simli service configuration missing.', { missingApiKey: !apiKey, missingAvatarId: !avatarId, missingVoiceId: !voiceId });
    throw new Error('Server configuration error: SIMLI_API_KEY and SIMLI_AVATAR_ID are required.');
  }

  return { apiKey, avatarId, voiceId: voiceId || avatarId };
}

function buildSimliError(message: string, status = 500): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

function getJsonMessage(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null) return undefined;
  const payload = json as { error?: { message?: unknown }; message?: unknown };
  const errorMessage = typeof payload.error?.message === 'string' ? payload.error.message : undefined;
  if (errorMessage) return errorMessage;
  return typeof payload.message === 'string' ? payload.message : undefined;
}

function extractSessionInfo(json: unknown): SimliStreamingSession {
  const payload = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
  const sessionToken = (payload.session_token as string | undefined) ?? (payload.sessionToken as string | undefined);
  if (!sessionToken || typeof sessionToken !== 'string') {
    throw buildSimliError('Simli session creation succeeded but did not return a valid session_token.', 502);
  }

  const streamId = (payload.stream_id as string | undefined) ?? (payload.streamId as string | undefined) ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = (payload.session_id as string | undefined) ?? (payload.sessionId as string | undefined) ?? streamId;
  const avatarId = (payload.avatar_id as string | undefined) ?? (payload.avatarId as string | undefined) ?? payload.faceId as string | undefined;
  const expiresAt = (payload.expires_at as string | undefined) ?? (payload.expiresAt as string | undefined);

  return {
    token: sessionToken,
    sessionToken,
    streamId,
    ...(sessionId ? { sessionId } : {}),
    ...(avatarId ? { avatarId } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    connected: true,
    status: 'active',
  };
}

function saveSession(session: SimliStreamingSession | SessionRecord) {
  if (!session?.streamId) return;
  activeSessions.set(session.streamId, {
    ...session,
    createdAt: 'createdAt' in session && typeof session.createdAt === 'string' ? session.createdAt : new Date().toISOString(),
    lastHeartbeatAt: 'lastHeartbeatAt' in session && typeof session.lastHeartbeatAt === 'string' ? session.lastHeartbeatAt : new Date().toISOString(),
  } as SessionRecord);
}

function removeSession(streamId: string) {
  activeSessions.delete(streamId);
}

function getSession(streamId: string): SessionRecord | undefined {
  if (!streamId) return undefined;
  return activeSessions.get(streamId);
}

export function getActiveSimliSession(streamId: string): SimliStreamingSession | undefined {
  return getSession(streamId);
}

export function getActiveSimliSessionForUser(userId: string): SimliStreamingSession | undefined {
  const session = findSessionByUser(userId);
  if (!session) return undefined;
  return session;
}

export async function claimLiveTutorSession(userId: string, requestId: string, avatarVoiceProfile: LiveTutorVoiceProfile = DEFAULT_LIVE_TUTOR_VOICE_PROFILE): Promise<boolean> {
  const preflight = await prisma.liveTutorSession.findUnique({ where: { userId } });
  if (preflight && isDurableSessionStale(preflight)) {
    logger.info('[LiveTutorLifecycle] heartbeat_expired', { streamId: preflight.streamId, sessionId: preflight.id, userId, reason: 'claim_preflight_recovery', previousStatus: preflight.status, resultingStatus: 'finalizing', category: 'live_tutor_lifecycle' });
    await completeSimliSessionLifecycle(preflight.streamId, { status: 'disconnected', reason: 'Heartbeat expired before new session claim' }, userId).catch((error) => {
      logger.warn('[LiveTutorLifecycle] claim_preflight_recovery_failed', { streamId: preflight.streamId, sessionId: preflight.id, userId, reason: error instanceof Error ? error.message : 'recovery_failed', previousStatus: preflight.status, resultingStatus: 'recovery_required', category: 'live_tutor_lifecycle' });
    });
  }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    const existing = await tx.liveTutorSession.findUnique({ where: { userId } });
    const now = new Date();
    if (existing && (isGenuinelyActiveSession(existing, now) || isFreshClaimInProgress(existing, now))) {
      const reason = isGenuinelyActiveSession(existing, now) ? 'genuinely_active_session' : 'claim_in_progress';
      logger.info('[LiveTutorLifecycle] claim_rejected_active', { streamId: existing.streamId, sessionId: existing.id, userId, reason, previousStatus: existing.status, resultingStatus: existing.status, category: 'live_tutor_lifecycle' });
      return false;
    }
    if (existing && !isTerminalSession(existing.status)) {
      logger.info('[LiveTutorLifecycle] stale_claim_non_blocking', { streamId: existing.streamId, sessionId: existing.id, userId, reason: isDurableSessionStale(existing, now) ? 'heartbeat_or_expiry_timeout' : 'non_active_lifecycle_state', previousStatus: existing.status, resultingStatus: 'creating', category: 'live_tutor_lifecycle' });
    }
    await tx.liveTutorSession.upsert({
      where: { userId },
      update: {
        streamId: `pending-${requestId}`, billingRequestId: requestId, avatarVoiceProfile, status: 'creating', createdAt: now,
        lastActivityAt: now, expiresAt: new Date(now.getTime() + MAX_SESSION_SECONDS * 1000),
        secondsConsumed: 0, billingFinalized: false, ownerProcessId: LIVE_TUTOR_PROCESS_ID, finalizationStartedAt: null, terminalStatus: null, terminalReason: null, finalizedAt: null,
      },
      create: {
        userId, streamId: `pending-${requestId}`, billingRequestId: requestId, avatarVoiceProfile, status: 'creating', createdAt: now,
        lastActivityAt: now, expiresAt: new Date(now.getTime() + MAX_SESSION_SECONDS * 1000), ownerProcessId: LIVE_TUTOR_PROCESS_ID,
      },
    });
    logStatusTransition({ streamId: `pending-${requestId}`, sessionId: existing?.id, userId, previousStatus: existing?.status ?? 'none', resultingStatus: 'creating', reason: 'new_session_claimed' });
    logger.info('[LiveTutorLifecycle] claim_created', { streamId: `pending-${requestId}`, sessionId: existing?.id ?? null, userId, reason: 'new_session_claimed', previousStatus: existing?.status ?? null, resultingStatus: 'creating', category: 'live_tutor_lifecycle' });
    return true;
  });
}

export async function releaseLiveTutorSessionClaim(userId: string, requestId: string): Promise<void> {
  const released = await prisma.liveTutorSession.deleteMany({ where: { userId, billingRequestId: requestId, status: 'creating' } });
  if (released.count > 0) logger.info('[LiveTutorLifecycle] claim_released', { userId, reason: 'claim_creation_failed', previousStatus: 'creating', resultingStatus: 'released', category: 'live_tutor_lifecycle' });
}

export async function reconcileStaleLiveTutorSession(userId: string): Promise<boolean> {
  const durable = await prisma.liveTutorSession.findUnique({ where: { userId } });
  if (!durable || !isDurableSessionStale(durable)) return false;
  logger.info('[LiveTutorLifecycle] heartbeat_expired', { streamId: durable.streamId, sessionId: durable.id, userId, reason: 'new_session_recovery', previousStatus: durable.status, resultingStatus: 'finalizing', category: 'live_tutor_lifecycle' });
  await completeSimliSessionLifecycle(durable.streamId, { status: 'disconnected', reason: 'Heartbeat expired; stale session recovery' }, userId);
  const reconciled = await prisma.liveTutorSession.findUnique({ where: { userId } });
  if (reconciled?.billingFinalized && isTerminalSession(reconciled.status)) {
    logger.info('[LiveTutorLifecycle] new_session_allowed_after_recovery', { streamId: durable.streamId, sessionId: durable.id, userId, reason: 'stale_session_reconciled', previousStatus: durable.status, resultingStatus: reconciled.status, category: 'live_tutor_lifecycle' });
    return true;
  }
  return false;
}

export async function createSimliStreamingAvatarSession(options: {
  requestId?: string;
  userId?: string;
  secondsReserved?: number;
  avatarVoiceProfile?: LiveTutorVoiceProfile;
} = {}): Promise<SimliStreamingSession> {
  const existing = findSessionByUser(options.userId);
  if (existing) {
    saveSession({
      ...existing,
      lastHeartbeatAt: new Date().toISOString(),
    });
    return {
      token: existing.token ?? existing.sessionToken,
      sessionToken: existing.sessionToken,
      streamId: existing.streamId,
      sessionId: existing.sessionId,
      avatarId: existing.avatarId,
      expiresAt: existing.expiresAt,
      connected: existing.connected,
      status: existing.status,
      avatarVoiceProfile: existing.avatarVoiceProfile,
    };
  }

  const { apiKey, avatarId } = requireSimliConfig();
  if (simliBreaker.isOpen()) {
    throw new Error('Simli is temporarily unavailable. Please try again shortly.');
  }

  logger.info('Creating Simli session token', { provider: 'simli' });
  const startedAt = Date.now();

  try {
    const response = await retryWithBackoff(async () => {
      const apiUrl = getSimliApiBaseUrl();
      const res = await fetch(`${apiUrl}/compose/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-simli-api-key': apiKey,
        },
        body: JSON.stringify({
          faceId: avatarId,
          handleSilence: true,
          maxSessionLength: 600,
          maxIdleTime: 180,
        }),
      });

      const rawResponse = await res.text();
      let json: unknown;
      try {
        json = rawResponse ? JSON.parse(rawResponse) : {};
      } catch {
        json = { raw: rawResponse };
      }

      if (!res.ok) {
        const error = new Error((json as { error?: { message?: string }; message?: string } | null | undefined)?.error?.message || (json as { error?: { message?: string }; message?: string } | null | undefined)?.message || 'Simli token request failed');
        (error as Error & { status: number }).status = res.status;
        throw error;
      }

      return json;
    }, {
      ...simliProviderOptions,
      retries: simliProviderOptions.retries,
      baseDelayMs: simliProviderOptions.baseDelayMs,
      maxDelayMs: simliProviderOptions.maxDelayMs,
      timeoutMs: simliProviderOptions.timeoutMs,
      provider: 'simli',
    });

    const sessionInfo = extractSessionInfo(response);
    logger.info('Simli session token created', { provider: 'simli', streamId: sessionInfo.streamId });
    const now = new Date().toISOString();
    saveSession({
      ...sessionInfo,
      billingRequestId: options.requestId,
      userId: options.userId,
      secondsReserved: options.secondsReserved ?? 60,
      secondsConsumed: 0,
      billingFinalized: false,
      avatarVoiceProfile: options.avatarVoiceProfile ?? DEFAULT_LIVE_TUTOR_VOICE_PROFILE,
      lastActivityAt: now,
    });
    await prisma.liveTutorSession.update({
      where: { userId: options.userId },
      data: { streamId: sessionInfo.streamId, avatarVoiceProfile: options.avatarVoiceProfile ?? DEFAULT_LIVE_TUTOR_VOICE_PROFILE, status: 'active', ownerProcessId: LIVE_TUTOR_PROCESS_ID, finalizationStartedAt: null, lastActivityAt: new Date(now), expiresAt: sessionInfo.expiresAt ? new Date(sessionInfo.expiresAt) : new Date(Date.parse(now) + MAX_SESSION_SECONDS * 1000) },
    });
    logStatusTransition({ streamId: sessionInfo.streamId, userId: options.userId ?? 'unknown', previousStatus: 'creating', resultingStatus: 'active', reason: 'simli_session_created' });
    simliBreaker.recordSuccess();
    observeMonitoringLatency('simli', Date.now() - startedAt, { provider: 'simli', operation: 'create_session' });
    return sessionInfo;
  } catch (error: unknown) {
    simliBreaker.recordFailure();
    const rawMessage = typeof error === 'object' && error !== null && 'message' in error ? (error as { message?: unknown }).message : undefined;
    const message = getClientErrorMessage(typeof rawMessage === 'string' ? rawMessage : undefined, 'Simli is temporarily unavailable. Please try again shortly.');
    logger.error('Simli session token creation error', {
      provider: 'simli',
      status: typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : null,
      message: typeof rawMessage === 'string' ? rawMessage : 'Unknown Simli error',
    });
    observeMonitoringLatency('simli', Date.now() - startedAt, { provider: 'simli', operation: 'create_session', status: 'error' });
    incrementMonitoringFailure('tutor', { provider: 'simli', reason: 'session_creation' });
    const clientError = new Error(message) as Error & { status?: number };
    const status = typeof (error as { status?: unknown })?.status === 'number'
      ? (error as { status: number }).status
      : undefined;
    if (status !== undefined) clientError.status = status;
    throw clientError;
  }
}

export async function markSimliSessionConnected(streamId: string): Promise<void> {
  const session = getSession(streamId);
  if (!session) return;
  const nextSession: SessionRecord = {
    ...session,
    createdAt: session.createdAt ?? new Date().toISOString(),
    connected: true,
    status: 'active' as const,
    lastHeartbeatAt: new Date().toISOString(),
  };
  activeSessions.set(streamId, nextSession);
  logger.info('Simli session marked as connected, avatar ready for response delivery', {
    provider: 'simli',
    streamId,
    userId: session.userId,
    category: 'simli_avatar_connected',
  });
}

export async function markSimliSessionDisconnected(streamId: string, reason?: string): Promise<void> {
  const session = getSession(streamId);
  if (!session) return;
  const nextSession: SessionRecord = {
    ...session,
    createdAt: session.createdAt ?? new Date().toISOString(),
    connected: false,
    status: 'disconnected' as const,
    lastHeartbeatAt: new Date().toISOString(),
  };
  if (reason) {
    logger.warn('Simli session disconnected', { provider: 'simli', streamId, reason });
  }
  activeSessions.set(streamId, nextSession);
  if (session.userId) {
    await completeSimliSessionLifecycle(streamId, { status: 'disconnected', reason: reason ?? 'Simli disconnected' }, session.userId);
  }
}

export async function reconnectSimliSession(streamId: string): Promise<SimliStreamingSession> {
  const previousSession = getSession(streamId);
  const replacement = await createSimliStreamingAvatarSession({
    requestId: previousSession?.billingRequestId,
    userId: previousSession?.userId,
    secondsReserved: previousSession?.secondsReserved ?? 60,
  });
  if (previousSession?.streamId) {
    removeSession(previousSession.streamId);
  }
  saveSession({ ...replacement, connected: false, status: 'reconnecting' });
  return replacement;
}

/**
 * Updates the last activity timestamp for a session.
 * This is called whenever the client sends a consume/heartbeat request.
 * Used for the 2-minute inactivity guardrail.
 */
export async function markSessionActivity(streamId: string, userId: string, reportedSeconds?: number): Promise<boolean> {
  const session = getSession(streamId);
  const durable = await prisma.liveTutorSession.findUnique({ where: { streamId } });
  if (!durable || durable.userId !== userId || durable.billingFinalized || durable.status !== 'active') return false;
  const now = new Date();
  if (durable.expiresAt && durable.expiresAt <= now) return false;
  if (now.getTime() - durable.lastActivityAt.getTime() < MIN_HEARTBEAT_INTERVAL_MS) return false;
  if (reportedSeconds !== undefined && (!Number.isFinite(reportedSeconds) || reportedSeconds < 0 || reportedSeconds > 90)) return false;
  await prisma.liveTutorSession.updateMany({ where: { streamId, userId, status: 'active', billingFinalized: false }, data: { lastActivityAt: now } });
  if (!session) return true;

  const nextSession: SessionRecord = {
    ...session,
    lastActivityAt: new Date().toISOString(),
  };
  activeSessions.set(streamId, nextSession);
  return true;
}

export async function sendRealtimeText(_streamId: string, _text: string): Promise<string> {
  throw new Error('Direct Simli /text send is not part of the verified Simli client flow. Gemini handles text generation and the browser client handles avatar speech.');
}

export async function completeSimliSessionLifecycle(streamId: string, options: {
  status: 'completed' | 'failed' | 'disconnected';
  secondsUsed?: number;
  reason?: string;
  finalizationClaimedAt?: Date;
}, userId?: string): Promise<void> {
  const session = getSession(streamId);
  const durable = await prisma.liveTutorSession.findUnique({ where: { streamId } });
  if (!durable || (userId && durable.userId !== userId)) throw buildSimliError('Live Tutor session not found.', 404);
  if (durable.billingFinalized) {
    logger.info('[LiveTutorLifecycle] terminal_finalize_duplicate', { streamId, sessionId: durable.id, userId: durable.userId, reason: options.reason ?? 'already_finalized', previousStatus: durable.status, resultingStatus: durable.status, category: 'live_tutor_lifecycle' });
    return;
  }
  const terminalStatus = durable.terminalStatus ?? options.status;
  const terminalReason = durable.terminalReason ?? options.reason;
  if (durable.status === 'finalizing' && terminalStatus && durable.finalizedAt === null) {
    const committed = await prisma.liveTutorSession.update({
      where: { streamId },
      data: {
        status: 'ended',
        terminalStatus,
        terminalReason,
        billingFinalized: true,
        finalizationStartedAt: null,
        finalizedAt: new Date(),
      },
    });
    logger.info('[LiveTutorLifecycle] live_tutor_terminal_state_committed', {
      streamId,
      sessionId: durable.id,
      userId: durable.userId,
      reason: terminalReason ?? 'finalizing_record_reconciled',
      previousStatus: durable.status,
      resultingStatus: committed.status,
      terminalStatus: committed.terminalStatus,
      category: 'live_tutor_lifecycle',
    });
    return;
  }
  if (!session) logger.warn('Live Tutor session is not in this process; finalizing from durable ledger', { streamId, userId: durable.userId, category: 'live_tutor_durable_reconciliation' });

  const staleFinalizationBefore = new Date(Date.now() - INACTIVITY_TIMEOUT_MS);
  const claim = await prisma.liveTutorSession.updateMany({
    where: {
      streamId,
      userId: durable.userId,
      billingFinalized: false,
      OR: [
        { status: { in: ['creating', 'active', 'reconnecting'] } },
        ...(options.finalizationClaimedAt ? [{ status: 'finalizing' as const, finalizationStartedAt: options.finalizationClaimedAt }] : []),
        { status: 'finalizing', finalizationStartedAt: { lt: staleFinalizationBefore } },
        { status: 'finalizing', finalizationStartedAt: null, lastActivityAt: { lt: staleFinalizationBefore } },
        { status: 'recovery_required', finalizationStartedAt: { lt: staleFinalizationBefore } },
        { status: 'recovery_required', finalizationStartedAt: null, lastActivityAt: { lt: staleFinalizationBefore } },
      ],
    },
    data: { status: 'finalizing', finalizationStartedAt: new Date() },
  });
  if (claim.count === 0) {
    const refreshed = await prisma.liveTutorSession.findUnique({ where: { streamId } });
    if (refreshed && refreshed.status === 'finalizing' && refreshed.terminalStatus && !refreshed.billingFinalized) {
      const committed = await prisma.liveTutorSession.update({
        where: { streamId },
        data: { status: 'ended', terminalStatus: refreshed.terminalStatus, terminalReason: refreshed.terminalReason ?? options.reason, billingFinalized: true, finalizationStartedAt: null, finalizedAt: new Date() },
      });
      logger.info('[LiveTutorLifecycle] live_tutor_terminal_state_committed', {
        streamId,
        sessionId: refreshed.id,
        userId: refreshed.userId,
        reason: refreshed.terminalReason ?? options.reason ?? 'finalizing_record_reconciled',
        previousStatus: refreshed.status,
        resultingStatus: committed.status,
        terminalStatus: committed.terminalStatus,
        category: 'live_tutor_lifecycle',
      });
      return;
    }
    logger.info('[LiveTutorLifecycle] terminal_finalize_duplicate', { streamId, sessionId: durable.id, userId: durable.userId, reason: 'finalization_in_progress_or_terminal', previousStatus: durable.status, resultingStatus: durable.status, category: 'live_tutor_lifecycle' });
    return;
  }

  logStatusTransition({ streamId, sessionId: durable.id, userId: durable.userId, previousStatus: durable.status, resultingStatus: 'finalizing', reason: options.reason ?? 'session_ended' });
  logger.info('[LiveTutorLifecycle] terminal_finalize_started', { streamId, sessionId: durable.id, userId: durable.userId, reason: options.reason ?? 'session_ended', previousStatus: durable.status, resultingStatus: 'finalizing', category: 'live_tutor_lifecycle' });

  const billableEnd = durable.expiresAt ? Math.min(Date.now(), durable.expiresAt.getTime()) : Date.now();
  const elapsedSeconds = Math.max(0, Math.floor((billableEnd - durable.createdAt.getTime()) / 1000));
  const requestedSeconds = Number.isFinite(options.secondsUsed)
    ? Math.max(0, Math.floor(options.secondsUsed ?? 0))
    : Math.min(MAX_SESSION_SECONDS, elapsedSeconds);
  const secondsUsed = Math.min(durable.secondsReserved || 60, requestedSeconds);
  const billableSeconds = secondsUsed > 0 ? secondsUsed : durable.secondsReserved || 60;
  
  logger.info('Simli session lifecycle event', {
    provider: 'simli',
    streamId,
    userId: durable.userId,
    status: options.status,
    reason: options.reason ?? 'No reason provided',
    secondsReserved: durable.secondsReserved,
    secondsUsed,
    category: `simli_session_${options.status}`,
  });

  const billingRequestId = durable.billingRequestId ?? session?.billingRequestId;
  const billingUserId = durable.userId;
  if (billingRequestId && billingUserId) {
    try {
      if (options.status === 'failed') {
        logger.warn('Simli session failed, rolling back usage', {
          provider: 'simli',
          streamId,
          userId: billingUserId,
          secondsUsed,
          reason: options.reason ?? 'Session failed',
          category: 'simli_session_failed_rollback',
        });
        await rollbackUsage({
          userId: billingUserId,
          feature: 'live_tutor',
          amount: billableSeconds,
          provider: 'Simli',
          requestId: billingRequestId,
          metadata: { streamId, status: options.status, reason: options.reason ?? 'Session failed' },
          pending: true,
        });
      } else {
        logger.info('Simli session completed successfully, finalizing usage', {
          provider: 'simli',
          streamId,
          userId: billingUserId,
          secondsReserved: durable.secondsReserved,
          secondsUsed,
          reason: options.reason ?? 'Session ended',
          category: 'simli_session_completed_finalized',
        });
        await finalizeUsage({
          userId: billingUserId,
          feature: 'live_tutor',
          amount: billableSeconds,
          provider: 'Simli',
          requestId: billingRequestId,
          metadata: { streamId, status: options.status, reason: options.reason ?? 'Session ended' },
          pending: true,
          secondsUsed,
        });
      }

      const updatedSession = getSession(streamId);
      if (updatedSession) {
        activeSessions.set(streamId, { ...updatedSession, billingFinalized: true });
        logger.info('Simli session marked as billing finalized', {
          provider: 'simli',
          streamId,
          userId: billingUserId,
          category: 'simli_session_finalized',
        });
      }
    } catch (error) {
      const recovery = await prisma.liveTutorSession.updateMany({ where: { streamId, billingFinalized: false, status: 'finalizing' }, data: { status: 'recovery_required', finalizationStartedAt: new Date() } }).catch(() => ({ count: 0 }));
      if (recovery.count > 0) logStatusTransition({ streamId, sessionId: durable.id, userId: durable.userId, previousStatus: 'finalizing', resultingStatus: 'recovery_required', reason: 'billing_finalization_failed' });
      logger.warn('Simli session billing lifecycle update failed', { provider: 'simli', streamId, userId: durable.userId, error: sanitizeForLogging(error), category: 'simli_session_finalization_error' });
      return;
    }
  }

  await prisma.liveTutorSession.update({ where: { streamId }, data: { status: 'ended', terminalStatus: options.status, terminalReason: options.reason, secondsConsumed: billableSeconds, billingFinalized: true, finalizationStartedAt: null, finalizedAt: new Date() } });
  logStatusTransition({ streamId, sessionId: durable.id, userId: durable.userId, previousStatus: 'finalizing', resultingStatus: 'ended', reason: options.reason ?? 'session_ended' });
  logger.info('[LiveTutorLifecycle] live_tutor_terminal_state_committed', { streamId, sessionId: durable.id, userId: durable.userId, reason: options.reason ?? 'session_ended', previousStatus: 'finalizing', resultingStatus: 'ended', terminalStatus: options.status, category: 'live_tutor_lifecycle' });
  logger.info('[LiveTutorLifecycle] terminal_finalize_completed', { streamId, sessionId: durable.id, userId: durable.userId, reason: options.reason ?? 'session_ended', previousStatus: 'finalizing', resultingStatus: 'ended', category: 'live_tutor_lifecycle' });
  logger.info('[LiveTutorLifecycle] claim_released', { streamId, sessionId: durable.id, userId: durable.userId, reason: 'terminal_finalization', previousStatus: 'finalizing', resultingStatus: 'ended', category: 'live_tutor_lifecycle' });
  if ((options.reason ?? '').toLowerCase().includes('stale') || (options.reason ?? '').toLowerCase().includes('heartbeat')) {
    logger.info('[LiveTutorLifecycle] stale_session_reconciled', { streamId, sessionId: durable.id, userId: durable.userId, reason: options.reason, previousStatus: 'finalizing', resultingStatus: 'ended', category: 'live_tutor_lifecycle' });
    logger.info('[LiveTutorLifecycle] stale_claim_released', { streamId, sessionId: durable.id, userId: durable.userId, reason: options.reason, previousStatus: 'finalizing', resultingStatus: 'ended', category: 'live_tutor_lifecycle' });
  }

  await closeRealtimeSession(streamId);
  logger.info('Simli realtime session closed', {
    provider: 'simli',
    streamId,
    userId: durable.userId,
    category: 'simli_session_closed',
  });
}

export async function closeRealtimeSession(streamId: string): Promise<void> {
  if (!streamId) return;
  removeSession(streamId);
}

export async function shutdownActiveSimliSessions(): Promise<void> {
  const sessions = [...activeSessions.values()];
  if (sessions.length === 0) return;

  await Promise.allSettled(sessions.map((session) => completeSimliSessionLifecycle(session.streamId, {
    status: 'failed',
    secondsUsed: session.secondsConsumed ?? 0,
    reason: 'Server shutdown',
  })));
}

export async function recoverDurableLiveTutorSessions(reason = 'Server startup recovery'): Promise<void> {
  const now = new Date();
  const staleFinalizationBefore = new Date(now.getTime() - INACTIVITY_TIMEOUT_MS);
  const sessions = await prisma.liveTutorSession.findMany({
    where: {
      billingFinalized: false,
      OR: [
        {
          status: { in: ['creating', 'active', 'reconnecting'] },
          OR: [
            { ownerProcessId: null },
            { ownerProcessId: { not: LIVE_TUTOR_PROCESS_ID } },
            { lastActivityAt: { lt: staleFinalizationBefore } },
            { expiresAt: { lte: now } },
          ],
        },
        { status: 'finalizing', finalizationStartedAt: { lt: staleFinalizationBefore } },
        { status: 'finalizing', finalizationStartedAt: null, lastActivityAt: { lt: staleFinalizationBefore } },
        { status: 'recovery_required', finalizationStartedAt: { lt: staleFinalizationBefore } },
        { status: 'recovery_required', finalizationStartedAt: null, lastActivityAt: { lt: staleFinalizationBefore } },
      ],
    },
    select: { id: true, streamId: true, userId: true, status: true, terminalStatus: true, finalizationStartedAt: true },
  }).catch(() => []);

  for (const session of sessions) {
    const isTerminalRecord = Boolean(session.terminalStatus && session.terminalStatus !== 'null');
    if (session.status === 'ended' || session.status === 'completed' || session.status === 'failed' || session.status === 'disconnected' || isTerminalRecord) {
      logger.info('[LiveTutorLifecycle] live_tutor_reconciliation_skipped_terminal', {
        streamId: session.streamId,
        sessionId: session.id,
        userId: session.userId,
        reason,
        previousStatus: session.status,
        resultingStatus: session.status,
        terminalStatus: session.terminalStatus ?? null,
        category: 'live_tutor_lifecycle',
      });
      continue;
    }
    const finalizationClaimedAt = new Date();
    const claim = await prisma.liveTutorSession.updateMany({
      where: {
        id: session.id,
        streamId: session.streamId,
        userId: session.userId,
        billingFinalized: false,
        status: session.status,
      },
      data: { status: 'finalizing', finalizationStartedAt: finalizationClaimedAt },
    });
    if (claim.count === 0) continue;
    logger.info('[LiveTutorLifecycle] startup_recovery_started', { streamId: session.streamId, sessionId: session.id, userId: session.userId, reason, previousStatus: session.status, resultingStatus: 'finalizing', category: 'live_tutor_lifecycle' });
    await completeSimliSessionLifecycle(session.streamId, { status: 'disconnected', reason, finalizationClaimedAt }, session.userId);
  }
  if (sessions.length > 0) logger.info('[LiveTutorLifecycle] startup_recovery_completed', { recoveredCount: sessions.length, reason, category: 'live_tutor_lifecycle' });
}

const SESSION_CLEANUP_INTERVAL_MS = 60 * 1000;
const sessionCleanupTimer = setInterval(async () => {
  const now = new Date();
  const inactiveBefore = new Date(now.getTime() - INACTIVITY_TIMEOUT_MS);
  const durableSessions = await prisma.liveTutorSession.findMany({
    where: {
      billingFinalized: false,
      status: { in: [...RECOVERABLE_STATUSES] },
      OR: [
        { lastActivityAt: { lt: inactiveBefore } },
        { expiresAt: { lte: now } },
        { status: 'finalizing', finalizationStartedAt: { lt: inactiveBefore } },
        { status: 'recovery_required', finalizationStartedAt: { lt: inactiveBefore } },
      ],
    },
    select: { streamId: true, userId: true, secondsConsumed: true },
  }).catch(() => []);
  await Promise.allSettled(durableSessions.map((session) => completeSimliSessionLifecycle(session.streamId, {
    status: 'disconnected',
    secondsUsed: session.secondsConsumed,
    reason: 'Durable session reconciliation timeout',
  }, session.userId)));

  const sessions = [...activeSessions.values()];
  for (const session of sessions) {
    // Check for stale sessions (no heartbeat for 10 minutes)
    if (isStaleSession(session)) {
      try {
        await completeSimliSessionLifecycle(session.streamId, {
          status: 'disconnected',
          secondsUsed: session.secondsConsumed ?? 0,
          reason: 'Session cleanup',
        });
      } catch {
        // ignore cleanup failures to keep interval alive
      }
      continue;
    }

    // Fix 4: Check for inactivity (no activity for 2 minutes) and close the session
    if (isSessionInactive(session)) {
      try {
        logger.warn('Live tutor session terminated due to 2-minute inactivity', { streamId: session.streamId, userId: session.userId });
        await completeSimliSessionLifecycle(session.streamId, {
          status: 'disconnected',
          secondsUsed: session.secondsConsumed ?? 0,
          reason: '2-minute inactivity timeout',
        });
      } catch {
        // ignore cleanup failures to keep interval alive
      }
    }
  }
}, SESSION_CLEANUP_INTERVAL_MS);
(sessionCleanupTimer as unknown as NodeJS.Timeout).unref();



