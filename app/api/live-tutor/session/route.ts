import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { LiveKitAPI } from 'livekit-server-sdk';
import { prisma } from '../../../../lib/prisma';
// Match your exact original exports from simliService
import { claimLiveTutorSession, closeLiveTutorRoom, completeSimliSessionLifecycle, createSimliStreamingAvatarSession, reconcileStaleLiveTutorSession, releaseLiveTutorSessionClaim, type SimliStreamingSession } from '../../../../services/simliService';
import { createLiveTutorSimliLiveKitAvatarSession, getLiveTutorSimliLiveKitConfig, SimliLiveKitAttachmentError, type LiveTutorSimliLiveKitAvatarSession } from '../../../../services/liveTutorSimliLiveKitAvatarSession';
import { DEFAULT_LIVE_TUTOR_VOICE_PROFILE } from '../../../../services/liveTutorVoiceProfiles';
import { resolveLiveTutorVoiceProfile } from '../../../../services/liveTutorVoiceProfiles';
import {
  AIRequestGatewayError,
  authenticateAIRequest,
  enforceAIGatewayRateLimit,
  getClientIp,
  buildAIRequestId,
} from '../../../../lib/aiSecurityGateway';
import logger from '../../../../lib/logger';
import { attachLiveTutorConversation, createLiveTutorConversation, getOwnedLiveTutorConversation } from '../../../../services/liveTutorConversationService';
import type { BillingDecision } from '../../../../services/billingService';
import { getLiveTutorMaxSessionSecondsForUser, LIVE_TUTOR_INACTIVITY_TIMEOUT_MS } from '../../../../lib/liveTutorLimits';
import { LIVE_TUTOR_AVATAR_TRANSPORTS, resolveLiveTutorAvatarTransport } from '../../../../services/liveTutorAvatarTransportPolicy';
import { validateLiveTutorVoiceProviderHandshake } from '../../../../services/liveTutorVoiceProvider';
import { getProductPolicy } from '../../../../services/productPolicy';
import { canUseLiveTutor } from '../../../../services/liveTutorBillingService';
import { resolveLiveTutorAgentNameForUser } from '../../../../lib/liveTutorAgentRouting';
import {
  acquireLiveTutorSessionLease,
  releaseActiveLiveTutorSessionCapacity,
  releaseLiveTutorAvatarStartCapacity,
  releaseLiveTutorSessionCapacity,
  reserveLiveTutorAvatarStartCapacity,
  reserveLiveTutorSessionCapacity,
  transferLiveTutorSessionCapacity,
} from '../../../../lib/realtimeRedis';

function requireSessionToken(session: { token?: unknown; sessionToken?: unknown }): string {
  const token = typeof session.token === 'string' && session.token.trim()
    ? session.token.trim()
    : typeof session.sessionToken === 'string' && session.sessionToken.trim()
    ? session.sessionToken.trim()
    : null;

  if (!token) {
    const error = new Error('Simli session did not return a valid session token.') as Error & { status: number };
    error.status = 502;
    throw error;
  }

  return token;
}

export async function GET(req: Request) {
  let claimedRequestId: string | undefined;
  const lifecycleTraceId = randomUUID().replaceAll('-', '');
  let claimedUserId: string | undefined;
  let cleanupStreamId: string | undefined;
  let capacityReservationRequestId: string | undefined;
  let capacityReservationStreamId: string | undefined;
  let liveKitSession: LiveTutorSimliLiveKitAvatarSession | undefined;
  const routePhaseStart = Date.now();
  const phaseTimers = new Map<string, number>();
  const markPhase = (name: string) => {
    const now = Date.now();
    phaseTimers.set(name, now - routePhaseStart);
    logger.info('Live Tutor session route phase', {
      phase: name,
      elapsedMs: now - routePhaseStart,
      category: 'live_tutor_session_phase',
      lifecycleTraceId,
    });
  };
  try {
    const user = await authenticateAIRequest(req);
    claimedUserId = user.id;
    const clientIp = getClientIp(req);
    await enforceAIGatewayRateLimit(user.id, clientIp);
    const requestUrl = new URL(req.url);
    const avatarTransport = resolveLiveTutorAvatarTransport(requestUrl.searchParams.get('avatarTransport'));
    if (!avatarTransport.ok) {
      return NextResponse.json(
        { error: 'Invalid Live Tutor avatar transport.' },
        { status: 400 },
      );
    }
    const requestedVoiceProfile = requestUrl.searchParams.get('avatarVoiceProfile');
    const requestedConversationId = requestUrl.searchParams.get('conversationId')?.trim() || null;
    const avatarVoiceProfile = requestedVoiceProfile === null
      ? DEFAULT_LIVE_TUTOR_VOICE_PROFILE
      : resolveLiveTutorVoiceProfile(requestedVoiceProfile);
    if (!avatarVoiceProfile) {
      return NextResponse.json({ error: 'Invalid Live Tutor avatar voice profile.' }, { status: 400 });
    }
    const maxSessionSeconds = getLiveTutorMaxSessionSecondsForUser(
      user.email,
      getProductPolicy('PRO').liveTutor.maxSessionSeconds,
    );
    let continuedConversationId: string | null = null;
    if (requestedConversationId) {
      const ownedConversation = await getOwnedLiveTutorConversation(requestedConversationId, user.id);
      if (!ownedConversation) {
        return NextResponse.json({ error: 'Live Tutor conversation not found.' }, { status: 404 });
      }
      continuedConversationId = ownedConversation.id;
    }

    logger.info('Live Tutor session request received', {
      userId: user.id,
      clientIp,
      category: 'live_tutor_session_start',
    });

    markPhase('request_received');

    const providerPreflightStartedAt = Date.now();
    const providerPreflightPromise = avatarTransport.transport === LIVE_TUTOR_AVATAR_TRANSPORTS.liveKit
      ? Promise.resolve().then(() => {
        logger.info('Live Tutor provider preflight skipped for LiveKit worker path', {
          category: 'live_tutor_voice_provider_preflight',
        });
        markPhase('provider_preflight_skipped');
      })
      : validateLiveTutorVoiceProviderHandshake()
        .then(() => {
          logger.info('Live Tutor provider preflight completed', {
            durationMs: Date.now() - providerPreflightStartedAt,
            category: 'live_tutor_voice_provider_preflight',
          });
          markPhase('provider_preflight');
        });

    const staleSessionReconcileStartedAt = Date.now();
    const staleSessionReconcilePromise = reconcileStaleLiveTutorSession(user.id)
      .then((reconciled) => {
        logger.info('Live Tutor stale session reconciliation completed', {
          durationMs: Date.now() - staleSessionReconcileStartedAt,
          category: 'live_tutor_stale_session_reconcile',
        });
        markPhase('stale_session_reconcile');
        return reconciled;
      });

    // This is a read-only entitlement snapshot.  It does not reserve minutes,
    // create a session, or loosen the durable per-user session claim below, so
    // it can safely overlap stale-session reconciliation and provider
    // preflight.  The existing claim remains the authority for one active
    // session per user.
    const billingStartedAt = Date.now();
    const billingDecisionPromise = canUseLiveTutor(user.id, 1)
      .then((decision) => {
        logger.info('Live Tutor lightweight allowance preflight completed', {
          durationMs: Date.now() - billingStartedAt,
          category: 'live_tutor_lightweight_billing_preflight',
        });
        markPhase('lightweight_billing_preflight');
        return decision;
      });

    const [providerPreflightResult, staleSessionReconcileResult, billingDecisionResult] = await Promise.allSettled([
      providerPreflightPromise,
      staleSessionReconcilePromise,
      billingDecisionPromise,
    ]);
    if (providerPreflightResult.status === 'rejected') {
      const error = providerPreflightResult.reason;
      logger.error('Live Tutor OpenAI provider preflight failed', {
        userId: user.id,
        message: error instanceof Error ? error.message : String(error),
        category: 'live_tutor_openai_preflight',
      });
      return NextResponse.json({ error: 'Live Tutor voice is temporarily unavailable. Please try again shortly.' }, { status: 503 });
    }
    if (staleSessionReconcileResult.status === 'rejected') {
      throw staleSessionReconcileResult.reason;
    }
    if (billingDecisionResult.status === 'rejected') {
      throw billingDecisionResult.reason;
    }

    const requestId = buildAIRequestId('simli-session');
    claimedRequestId = requestId;
    cleanupStreamId = `pending-${requestId}`;
    const claimStartedAt = Date.now();
    const claimResult = await claimLiveTutorSession(user.id, requestId, avatarVoiceProfile);
    logger.info('Live Tutor session claim completed', {
      durationMs: Date.now() - claimStartedAt,
      claimResult,
      category: 'live_tutor_session_claim',
    });
    markPhase('session_claim');
    if (!claimResult) {
      logger.warn('[LiveTutorLifecycle] claim_rejected_active', { userId: user.id, reason: 'another_genuinely_active_session', resultingStatus: 'active', category: 'live_tutor_session_rejected_active' });
      return NextResponse.json({ error: 'A Live Tutor session is already active on another device.' }, { status: 409 });
    }
    logger.info('Creating new Live Tutor session', {
      userId: user.id,
      requestId,
      category: 'live_tutor_session_creating',
    });

    // A stale session can finalize minutes while the preflight read is in
    // flight. Re-read only in that recovery case so a user is never admitted
    // using a balance that the reconciliation just consumed.
    const billingDecision: BillingDecision = staleSessionReconcileResult.value
      ? await canUseLiveTutor(user.id, 1)
      : billingDecisionResult.value;
    if (staleSessionReconcileResult.value) {
      logger.info('Live Tutor lightweight allowance revalidated after stale-session recovery', {
        durationMs: Date.now() - billingStartedAt,
        category: 'live_tutor_lightweight_billing_revalidation',
      });
      markPhase('lightweight_billing_revalidation');
    }
    logger.info('Live Tutor lightweight allowance check completed', {
      durationMs: Date.now() - billingStartedAt,
      category: 'live_tutor_lightweight_billing_check',
    });
    markPhase('lightweight_billing_check');

    if (!billingDecision.allowed) {
      throw new AIRequestGatewayError(429, {
        error: 'Your current Mento usage allowance has been reached.',
        code: 'product_allowance_exhausted',
        retryable: false,
        feature: 'live_tutor',
        upgradeAvailable: billingDecision.upgradeAvailable,
        remainingUsage: billingDecision.remainingUsage,
        resetTime: billingDecision.resetTime,
        dailyResetTime: billingDecision.dailyResetTime,
        monthlyResetTime: billingDecision.monthlyResetTime,
        limitScope: billingDecision.limitScope,
      });
    }

    // Simli's plan is a global provider limit, not a per-phone limit. Reserve
    // a slot in Redis before an avatar is created so Cloud Run replicas cannot
    // race each other into provider throttling. This happens before minutes
    // are reserved, so a busy service never charges a user for a failed start.
    const capacityReserved = await reserveLiveTutorSessionCapacity(requestId);
    if (!capacityReserved) {
      await releaseLiveTutorSessionClaim(user.id, requestId);
      claimedRequestId = undefined;
      cleanupStreamId = undefined;
      logger.info('Live Tutor global session capacity reached', {
        category: 'live_tutor_capacity_full',
      });
      return NextResponse.json(
        {
          error: 'All Live Tutor sessions are in use right now. Please try again shortly.',
          code: 'live_tutor_capacity_full',
          retryable: true,
        },
        { status: 503, headers: { 'Retry-After': '30' } },
      );
    }
    capacityReservationRequestId = requestId;

    // The lightweight preflight asks for one second only as an authorization
    // probe, so its remainingUsage is balance minus one. Restore that probe
    // second when setting the actual session reservation; otherwise every
    // session silently loses one second before it can be used.
    const availableSecondsAfterPreflight = Math.max(0, (billingDecision.remainingUsage ?? 0) + 1);
    const authorizedSeconds = Math.min(maxSessionSeconds, availableSecondsAfterPreflight);
    // The duration is reserved at admission, but it must not begin to elapse
    // while LiveKit/Simli are still bringing media online.  The worker marks
    // this session usable only after mobile has proved strict readiness.
    const serverSessionExpiresAt = new Date(Date.now() + Math.max(1, authorizedSeconds) * 1000);
    const liveTutorConversation = continuedConversationId
      ? { id: continuedConversationId }
      : await createLiveTutorConversation(user.id);
    const simliCreateStartedAt = Date.now();
    let session: SimliStreamingSession;
    let liveKitUrl: string | undefined;

    if (avatarTransport.transport === LIVE_TUTOR_AVATAR_TRANSPORTS.liveKit) {
      const liveKitConfig = getLiveTutorSimliLiveKitConfig({
        roomName: `mento-live-tutor-${requestId}`,
        agentIdentity: `mento-live-tutor-agent-${user.id}`,
        subscriberIdentity: `mento-live-tutor-subscriber-${user.id}`,
      });
      liveKitUrl = liveKitConfig.liveKitUrl;
      const avatarStartReserved = await reserveLiveTutorAvatarStartCapacity(requestId);
      if (!avatarStartReserved) {
        const error = new Error('Live Tutor avatar startup capacity is currently full.') as Error & { status?: number };
        error.status = 503;
        throw error;
      }
      try {
        liveKitSession = await createLiveTutorSimliLiveKitAvatarSession({
          ...liveKitConfig,
          maxSessionLength: authorizedSeconds,
        });
      } finally {
        await releaseLiveTutorAvatarStartCapacity(requestId).catch(() => undefined);
      }

      // Make the durable session visible before transferring its global slot.
      // If the following steps fail, lifecycle finalization releases the slot.
      cleanupStreamId = liveKitSession.streamId;
      await prisma.liveTutorSession.updateMany({
        where: { userId: user.id, streamId: `pending-${requestId}` },
        data: {
          streamId: liveKitSession.streamId,
          status: 'active',
          expiresAt: serverSessionExpiresAt,
          secondsReserved: authorizedSeconds,
          lastActivityAt: new Date(),
        },
      });
      const capacityTransferred = await transferLiveTutorSessionCapacity(requestId, liveKitSession.streamId);
      if (!capacityTransferred) {
        throw new Error('Live Tutor capacity reservation expired before session startup completed.');
      }
      capacityReservationRequestId = undefined;
      capacityReservationStreamId = liveKitSession.streamId;

      const liveKitApi = new LiveKitAPI({
        host: liveKitConfig.liveKitUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:'),
        apiKey: liveKitConfig.liveKitApiKey,
        secret: liveKitConfig.liveKitApiSecret,
      });
      const agentDispatchStartedAt = Date.now();
      const agentName = resolveLiveTutorAgentNameForUser(user.email);
      const dispatch = await liveKitApi.agentDispatch.createDispatch(
        liveKitSession.roomName,
        agentName,
        // Keep the provisional expiry for already-deployed workers during a
        // rolling upgrade. New workers ignore it and obtain a fresh expiry
        // only after strict readiness through worker-ready.
        { metadata: JSON.stringify({ requestId, lifecycleTraceId, userId: user.id, streamId: liveKitSession.streamId, conversationId: liveTutorConversation.id, mobileParticipantIdentity: liveKitConfig.subscriberIdentity, sessionExpiresAt: serverSessionExpiresAt.toISOString() }) },
      );
      logger.info('Live Tutor LiveKit agent dispatched', {
        roomName: liveKitSession.roomName,
        dispatchId: dispatch.id,
        agentName,
        durationMs: Date.now() - agentDispatchStartedAt,
        simliTokenCreateMs: liveKitSession.startupTimings.simliSessionCreateMs,
        simliLiveKitAttachMs: liveKitSession.startupTimings.simliLiveKitAttachMs,
        tokenPreparationMs: liveKitSession.startupTimings.tokenPreparationMs,
        category: 'live_tutor_livekit_agent_dispatch',
      });
      const leaseAcquired = await acquireLiveTutorSessionLease(liveKitSession.streamId, {
        userId: user.id,
        streamId: liveKitSession.streamId,
        roomName: liveKitSession.roomName,
        status: 'active',
      });
      if (!leaseAcquired) {
        throw new Error('A Live Tutor session coordinator is already active for this session.');
      }
      await attachLiveTutorConversation(liveKitSession.streamId, user.id, liveTutorConversation.id);
      session = {
        token: liveKitSession.token,
        sessionToken: liveKitSession.sessionToken,
        streamId: liveKitSession.streamId,
        sessionId: liveKitSession.sessionId,
        avatarId: liveKitSession.avatarId,
        expiresAt: serverSessionExpiresAt.toISOString(),
        connected: true,
        status: 'active',
        avatarVoiceProfile,
      };
      logger.info('Live Tutor Simli LiveKit session creation completed', {
        durationMs: Date.now() - simliCreateStartedAt,
        streamId: session.streamId,
        roomName: liveKitSession.roomName,
        category: 'live_tutor_livekit_session_create',
      });
    } else {
      session = await createSimliStreamingAvatarSession({
        requestId,
        userId: user.id,
        secondsReserved: authorizedSeconds,
        maxSessionSeconds: authorizedSeconds,
        avatarVoiceProfile,
      });
      await attachLiveTutorConversation(session.streamId, user.id, liveTutorConversation.id);
      logger.info('Live Tutor Simli session creation completed', {
        durationMs: Date.now() - simliCreateStartedAt,
        streamId: session.streamId,
        category: 'live_tutor_simli_session_create',
      });
    }
    markPhase('simli_session_create');
    logger.info('Live Tutor session bootstrap completed', {
      durationMs: Date.now() - simliCreateStartedAt,
      category: 'live_tutor_session_bootstrap',
    });
    markPhase('session_bootstrap');
    cleanupStreamId = session.streamId;
    const availableSessionSeconds = Math.min(
      maxSessionSeconds,
      Math.max(0, billingDecision.remainingUsage ?? 0),
    );
    const availableBalanceSeconds = Math.max(0, billingDecision.remainingUsage ?? 0);

    logger.info('Live Tutor session created successfully', {
      userId: user.id,
      sessionId: session.sessionId,
      streamId: session.streamId,
      billingAllowed: billingDecision.allowed,
      billingReason: billingDecision.reason,
      remainingSeconds: billingDecision.remainingUsage ?? 0,
      requestId,
      category: 'live_tutor_session_created',
    });

    if (billingDecision.remainingUsage !== null && billingDecision.remainingUsage <= 0) {
      logger.warn('Live Tutor balance exhausted after session creation', {
        userId: user.id,
        sessionId: session.sessionId,
        streamId: session.streamId,
        requestId,
        category: 'live_tutor_balance_exhausted',
      });
      // Session tracking remains safe inside local service memory allocation array maps
    }

    // Fixed: Using session.token to seamlessly resolve data payload transmission parameters
    const sessionToken = requireSessionToken(session);
    const responsePayload = {
      sessionToken,
      streamId: session.streamId,
      sessionId: session.sessionId,
      avatarId: session.avatarId,
      expiresAt: session.expiresAt,
      avatarVoiceProfile,
      conversationId: liveTutorConversation.id,
      avatarTransport: avatarTransport.transport,
      lifecycleTraceId,
      ...(liveKitSession ? {
        liveKitUrl,
        roomName: liveKitSession.roomName,
        subscriberToken: liveKitSession.subscriberToken,
        participantToken: liveKitSession.subscriberToken,
        avatarIdentity: liveKitSession.avatarIdentity,
      } : {}),
      billing: billingDecision,
      limits: {
        maxSessionSeconds,
        authorizedSessionSeconds: availableSessionSeconds,
        availableBalanceSeconds,
        inactivityTimeoutSeconds: Math.floor(LIVE_TUTOR_INACTIVITY_TIMEOUT_MS / 1000),
      },
    };

    logger.info('Live Tutor route completed', {
      totalElapsedMs: Date.now() - routePhaseStart,
      phaseBreakdown: Object.fromEntries(phaseTimers.entries()),
      lifecycleTraceId,
      category: 'live_tutor_session_route_complete',
    });
    return NextResponse.json(responsePayload);
  } catch (error: unknown) {
    // If provider setup succeeded but a later handoff failed, the durable
    // Redis lease may not exist yet. Close the room directly so the remote
    // Simli attachment cannot linger and consume the provider slot.
    if (liveKitSession?.roomName) {
      await closeLiveTutorRoom(liveKitSession.roomName).catch(() => undefined);
    }
    const errorRequestId = claimedRequestId;
    if (capacityReservationRequestId) {
      await releaseLiveTutorSessionCapacity(capacityReservationRequestId).catch(() => undefined);
    }
    if (capacityReservationStreamId) {
      await releaseActiveLiveTutorSessionCapacity(capacityReservationStreamId).catch(() => undefined);
    }
    if (claimedUserId && cleanupStreamId) {
      await completeSimliSessionLifecycle(cleanupStreamId, {
        status: 'failed',
        timing: 'active_end',
        reason: 'Live Tutor session initialization failed',
        secondsUsed: 0,
      }, claimedUserId).catch(() => undefined);
    } else if (claimedRequestId && claimedUserId) {
      await releaseLiveTutorSessionClaim(claimedUserId, claimedRequestId).catch(() => undefined);
    }
    claimedRequestId = undefined;
    claimedUserId = undefined;
    if (error instanceof AIRequestGatewayError) {
      const body = typeof error.body === 'object' && error.body !== null
        ? error.body as Record<string, unknown>
        : null;
      const liveTutorAllowanceExhausted = error.status === 429 && body?.code === 'product_allowance_exhausted';
      logger.info('Live Tutor session request blocked', {
        status: error.status,
        reason: body?.error ?? 'unknown',
        category: 'live_tutor_session_blocked',
      });
      return NextResponse.json(error.body, { status: liveTutorAllowanceExhausted ? 402 : error.status });
    }

    const message = error instanceof Error ? error.message : 'Internal Server Error';
    const status = (error as { status?: number })?.status ?? 500;
    const isCapacityFull = status === 503 && message.includes('capacity');
    const isSimliThrottled = error instanceof SimliLiveKitAttachmentError && error.status === 429;
    const isUnavailable = isCapacityFull || isSimliThrottled || Boolean(message && (message.includes('temporarily unavailable') || message.includes('circuit')));

    logger.error('Live Tutor session initialization failed', {
      status,
      category: isCapacityFull ? 'live_tutor_capacity_full' : isUnavailable ? 'provider_unavailable' : 'session_error',
      message: isCapacityFull ? 'Live Tutor capacity full' : isUnavailable ? 'Simli unavailable' : 'Session error',
      error: message,
      ...(error instanceof SimliLiveKitAttachmentError ? {
        provider: 'simli_livekit',
        providerStatus: error.status,
        providerReason: error.providerReason,
      } : {}),
    });

    const userMessage = isCapacityFull || isSimliThrottled
      ? 'Live Tutor is busy right now. Please wait a moment before trying again.'
      : isUnavailable
      ? 'Live Tutor is temporarily unavailable. Please try again in a moment.'
      : 'Unable to start Live Tutor. Please check your connection and try again.';

    return NextResponse.json({ error: userMessage, requestId: errorRequestId }, { status });
  }
}


