import { NextResponse } from 'next/server';
// Match your exact original exports from simliService
import { claimLiveTutorSession, completeSimliSessionLifecycle, createSimliStreamingAvatarSession, reconcileStaleLiveTutorSession, releaseLiveTutorSessionClaim } from '../../../../services/simliService';
import { DEFAULT_LIVE_TUTOR_VOICE_PROFILE } from '../../../../services/liveTutorVoiceProfiles';
import {
  AIRequestGatewayError,
  authenticateAIRequest,
  enforceAIGatewayRateLimit,
  executeAIRequest,
  getClientIp,
  buildAIRequestId,
} from '../../../../lib/aiSecurityGateway';
import { isDevLiveTutorFreeEnabled } from '../../../../lib/env';
import logger from '../../../../lib/logger';
import { attachLiveTutorConversation, createLiveTutorConversation } from '../../../../services/liveTutorConversationService';

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
  try {
    const user = await authenticateAIRequest(req);
    claimedUserId = user.id;
    const clientIp = getClientIp(req);
    await enforceAIGatewayRateLimit(user.id, clientIp);
    const avatarVoiceProfile = DEFAULT_LIVE_TUTOR_VOICE_PROFILE;
    if (!avatarVoiceProfile) {
      return NextResponse.json({ error: 'Invalid Live Tutor avatar voice profile.' }, { status: 400 });
    }

    logger.info('Live Tutor session request received', {
      userId: user.id,
      clientIp,
      category: 'live_tutor_session_start',
    });

    await reconcileStaleLiveTutorSession(user.id);

    const requestId = buildAIRequestId('simli-session');
    claimedRequestId = requestId;
    cleanupStreamId = `pending-${requestId}`;
    if (!await claimLiveTutorSession(user.id, requestId, avatarVoiceProfile)) {
      logger.warn('[LiveTutorLifecycle] claim_rejected_active', { userId: user.id, reason: 'another_genuinely_active_session', resultingStatus: 'active', category: 'live_tutor_session_rejected_active' });
      return NextResponse.json({ error: 'A Live Tutor session is already active on another device.' }, { status: 409 });
    }
    const devLiveTutorFree = isDevLiveTutorFreeEnabled();

    logger.info('Creating new Live Tutor session', {
      userId: user.id,
      requestId,
      devLiveTutorFree,
      category: 'live_tutor_session_creating',
    });

    let session: any;
    let billingDecision;

    if (devLiveTutorFree) {
      session = await createSimliStreamingAvatarSession({ requestId, userId: user.id, secondsReserved: 60, avatarVoiceProfile });
      billingDecision = {
        allowed: true,
        reason: '[DEV] Live tutor free mode enabled.',
        remainingUsage: null,
        resetTime: null,
        upgradeAvailable: false,
        usage: {
          feature: 'live_tutor',
          scope: 'day',
          used: 0,
          limit: null,
          remaining: null,
          resetAt: null,
        },
      };
    } else {
      const result = await executeAIRequest({
        user,
        clientIp,
        feature: 'live_tutor',
        provider: 'Simli',
        amount: 60,
        requestId,
        metadata: { streamType: 'avatar-session' },
        pending: true,
        finalize: false,
        callback: async () => await createSimliStreamingAvatarSession({ requestId, userId: user.id, secondsReserved: 60, avatarVoiceProfile }),
      });
      session = result.result;
      billingDecision = result.billingDecision;
    }
    cleanupStreamId = session.streamId;

    logger.info('Live Tutor session created successfully', {
      userId: user.id,
      sessionId: session.sessionId,
      streamId: session.streamId,
      billingAllowed: billingDecision.allowed,
      billingReason: billingDecision.reason,
      remainingSeconds: billingDecision.remainingUsage ?? 0,
      requestId,
      devLiveTutorFree,
      category: 'live_tutor_session_created',
    });

    if (!devLiveTutorFree && billingDecision.remainingUsage !== null && billingDecision.remainingUsage <= 0) {
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
    let conversationId: string | null = null;
    try {
      const conversation = await createLiveTutorConversation(user.id);
      conversationId = conversation.id;
      await attachLiveTutorConversation(session.streamId, user.id, conversation.id);
    } catch (error) {
      logger.warn('Live Tutor conversation preparation failed; continuing voice session', {
        userId: user.id,
        streamId: session.streamId,
        error: error instanceof Error ? error.message : String(error),
        category: 'live_tutor_conversation_persistence',
      });
    }
    return NextResponse.json({
      sessionToken,
      streamId: session.streamId,
      sessionId: session.sessionId,
      avatarId: session.avatarId,
      expiresAt: session.expiresAt,
      avatarVoiceProfile,
      conversationId,
      billing: billingDecision,
    });
  } catch (error: unknown) {
    const errorRequestId = claimedRequestId;
    if (claimedUserId && cleanupStreamId) {
      await completeSimliSessionLifecycle(cleanupStreamId, {
        status: 'failed',
        reason: 'Live Tutor session initialization failed',
        secondsUsed: 0,
      }, claimedUserId).catch(() => undefined);
    } else if (claimedRequestId && claimedUserId) {
      await releaseLiveTutorSessionClaim(claimedUserId, claimedRequestId).catch(() => undefined);
    }
    claimedRequestId = undefined;
    claimedUserId = undefined;
    if (error instanceof AIRequestGatewayError) {
      logger.info('Live Tutor session request blocked', {
        status: error.status,
        reason: typeof error.body === 'object' && error.body !== null ? (error.body as Record<string, unknown>).error : 'unknown',
        category: 'live_tutor_session_blocked',
      });
      return NextResponse.json(error.body, { status: error.status });
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
