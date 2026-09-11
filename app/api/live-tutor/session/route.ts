import { NextResponse } from 'next/server';
// Match your exact original exports from simliService
import { claimLiveTutorSession, completeSimliSessionLifecycle, createSimliStreamingAvatarSession, reconcileStaleLiveTutorSession, releaseLiveTutorSessionClaim, type SimliStreamingSession } from '../../../../services/simliService';
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
  let claimedUserId: string | undefined;
  let cleanupStreamId: string | undefined;
  const routePhaseStart = Date.now();
  const phaseTimers = new Map<string, number>();
  const markPhase = (name: string) => {
    const now = Date.now();
    phaseTimers.set(name, now - routePhaseStart);
    logger.info('Live Tutor session route phase', {
      phase: name,
      elapsedMs: now - routePhaseStart,
      category: 'live_tutor_session_phase',
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
        { error: avatarTransport.reason === 'invalid_transport' ? 'Invalid Live Tutor avatar transport.' : 'Live Tutor experiment unavailable.' },
        { status: avatarTransport.reason === 'invalid_transport' ? 400 : 404 },
      );
    }
    if (avatarTransport.transport === LIVE_TUTOR_AVATAR_TRANSPORTS.liveKitPoc) {
      return NextResponse.json(
        { error: 'The LiveKit avatar proof of concept is enabled but its isolated worker is not installed yet.' },
        { status: 501 },
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

    try {
      const providerPreflightStartedAt = Date.now();
      await validateLiveTutorVoiceProviderHandshake();
      logger.info('Live Tutor provider preflight completed', {
        durationMs: Date.now() - providerPreflightStartedAt,
        category: 'live_tutor_voice_provider_preflight',
      });
      markPhase('provider_preflight');
    } catch (error) {
      logger.error('Live Tutor OpenAI provider preflight failed', {
        userId: user.id,
        message: error instanceof Error ? error.message : String(error),
        category: 'live_tutor_openai_preflight',
      });
      return NextResponse.json({ error: 'Live Tutor voice is temporarily unavailable. Please try again shortly.' }, { status: 503 });
    }

    const staleSessionReconcileStartedAt = Date.now();
    await reconcileStaleLiveTutorSession(user.id);
    logger.info('Live Tutor stale session reconciliation completed', {
      durationMs: Date.now() - staleSessionReconcileStartedAt,
      category: 'live_tutor_stale_session_reconcile',
    });
    markPhase('stale_session_reconcile');

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

    const billingStartedAt = Date.now();
    const billingDecision: BillingDecision = await canUseLiveTutor(user.id, 1);
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

    const authorizedSeconds = Math.min(
      maxSessionSeconds,
      Math.max(0, billingDecision.remainingUsage ?? 0),
    );
    const simliCreateStartedAt = Date.now();
    const session: SimliStreamingSession = await createSimliStreamingAvatarSession({
      requestId,
      userId: user.id,
      secondsReserved: authorizedSeconds,
      maxSessionSeconds: authorizedSeconds,
      avatarVoiceProfile,
    });
    logger.info('Live Tutor Simli session creation completed', {
      durationMs: Date.now() - simliCreateStartedAt,
      streamId: session.streamId,
      category: 'live_tutor_simli_session_create',
    });
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
      conversationId: continuedConversationId,
      avatarTransport: avatarTransport.transport,
      billing: billingDecision,
      limits: {
        maxSessionSeconds,
        authorizedSessionSeconds: availableSessionSeconds,
        availableBalanceSeconds,
        inactivityTimeoutSeconds: Math.floor(LIVE_TUTOR_INACTIVITY_TIMEOUT_MS / 1000),
      },
    };

    const conversationStartedAt = Date.now();
    void (async () => {
      let conversationId: string | null = continuedConversationId;
      try {
        const conversation = continuedConversationId
          ? { id: continuedConversationId }
          : await createLiveTutorConversation(user.id);
        conversationId = conversation.id;
        await attachLiveTutorConversation(session.streamId, user.id, conversation.id);
      } catch (error) {
        logger.warn('Live Tutor conversation preparation failed; continuing voice session', {
          userId: user.id,
          streamId: session.streamId,
          error: error instanceof Error ? error.message : String(error),
          category: 'live_tutor_conversation_persistence',
        });
        return;
      }
      logger.info('Live Tutor conversation attachment completed', {
        durationMs: Date.now() - conversationStartedAt,
        streamId: session.streamId,
        conversationId,
        category: 'live_tutor_conversation_attachment',
      });
      markPhase('conversation_attachment');
    })();

    logger.info('Live Tutor route completed', {
      totalElapsedMs: Date.now() - routePhaseStart,
      phaseBreakdown: Object.fromEntries(phaseTimers.entries()),
      category: 'live_tutor_session_route_complete',
    });
    return NextResponse.json(responsePayload);
  } catch (error: unknown) {
    const errorRequestId = claimedRequestId;
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
    const isUnavailable = message && (message.includes('temporarily unavailable') || message.includes('circuit'));

    logger.error('Live Tutor session initialization failed', {
      status,
      category: isUnavailable ? 'provider_unavailable' : 'session_error',
      message: isUnavailable ? 'Simli unavailable' : 'Session error',
      error: message,
    });

    const userMessage = isUnavailable
      ? 'Live Tutor is temporarily unavailable. Please try again in a moment.'
      : 'Unable to start Live Tutor. Please check your connection and try again.';

    return NextResponse.json({ error: userMessage, requestId: errorRequestId }, { status });
  }
}
