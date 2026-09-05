import { NextResponse } from 'next/server';
import { classifyLiveTutorFinalizationTiming, closeRealtimeSession, completeSimliSessionLifecycle, markSessionActivity } from '../../../../services/simliService';
import {
  AIRequestGatewayError,
  authenticateAIRequest,
  enforceAIGatewayRateLimit,
  executeAIRequest,
  getClientIp,
  buildAIRequestId,
} from '../../../../lib/aiSecurityGateway';
import { buildCorsHeaders } from '../../../../lib/securityHeaders';
import logger from '../../../../lib/logger';

const CORS_METHODS = 'POST, OPTIONS';

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
}

export async function POST(req: Request) {
  try {
    const user = await authenticateAIRequest(req);
    const clientIp = getClientIp(req);
    await enforceAIGatewayRateLimit(user.id, clientIp);

    let body: { seconds?: unknown; streamId?: unknown; status?: unknown; reason?: unknown } | null = null;
    try {
      body = (await req.json()) as { seconds?: unknown; streamId?: unknown; status?: unknown; reason?: unknown };
    } catch {
      logger.warn('Invalid JSON in live-tutor consume', { userId: user.id, category: 'live_tutor_invalid_json' });
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const seconds = typeof body?.seconds === 'number' && Number.isFinite(body.seconds) && body.seconds >= 0 ? Math.floor(body.seconds) : 0;
    const streamId = typeof body?.streamId === 'string' && body.streamId.trim() ? body.streamId.trim() : undefined;
    const status = typeof body?.status === 'string' ? body.status : undefined;
    const reason = typeof body?.reason === 'string' && body.reason.trim()
      ? body.reason.trim().replace(/[\r\n\t]+/g, ' ').slice(0, 200)
      : undefined;
    const requestId = buildAIRequestId('live-tutor-consume');

    // Track activity for the 90-second inactivity guardrail.
    if (streamId) {
      const activityAccepted = await markSessionActivity(streamId, user.id, seconds);
      if (!activityAccepted && !status) {
        logger.warn('Live Tutor heartbeat rejected', { userId: user.id, streamId, category: 'live_tutor_heartbeat_rejected' });
        return NextResponse.json({ error: 'Live Tutor session is invalid, expired, or not owned by this user.' }, { status: 403, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
      }
      logger.info('Live Tutor session activity marked', {
        userId: user.id,
        streamId,
        requestId,
        category: 'live_tutor_activity_marked',
      });
    }

    if (status && streamId && ['completed','failed','disconnected'].includes(status)) {
      logger.info('Live Tutor session lifecycle event', {
        userId: user.id,
        streamId,
        status,
        reason,
        secondsUsed: seconds,
        requestId,
        category: 'live_tutor_session_lifecycle',
      });
      await completeSimliSessionLifecycle(streamId, {
        status: status as 'completed' | 'failed' | 'disconnected',
        timing: classifyLiveTutorFinalizationTiming(reason),
        secondsUsed: seconds,
        reason,
      }, user.id);
      return NextResponse.json({ ok: true, status, streamId }, { headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    if (streamId) {
      return NextResponse.json({ ok: true, heartbeat: true, streamId }, { headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    logger.info('Live Tutor message consumption starting', {
      userId: user.id,
      streamId: streamId ?? 'no-stream',
      secondsRequested: seconds,
      requestId,
      category: 'live_tutor_message_start',
    });

    const { result, billingDecision } = await executeAIRequest({
      user,
      clientIp,
      feature: 'live_tutor',
      provider: 'Simli',
      amount: seconds,
      requestId,
      metadata: { seconds, streamId: streamId ?? null },
      pending: true,
      callback: async ({ billingDecision }) => ({ remaining: billingDecision.remainingUsage ?? 0 }),
    });

    logger.info('Live Tutor message consumption completed', {
      userId: user.id,
      streamId: streamId ?? 'no-stream',
      billingAllowed: billingDecision.allowed,
      billingReason: billingDecision.reason,
      remainingSeconds: billingDecision.remainingUsage ?? 0,
      requestId,
      category: 'live_tutor_message_complete',
    });

    if (billingDecision.remainingUsage !== null && billingDecision.remainingUsage <= 0 && streamId) {
      logger.warn('Live Tutor balance exhausted, closing session', {
        userId: user.id,
        streamId,
        requestId,
        category: 'live_tutor_balance_exhausted_consume',
      });
      try {
        await closeRealtimeSession(streamId).catch(() => undefined);
      } catch {
        // ignore close errors
      }
    }

    return NextResponse.json({ remaining: (result as { remaining?: number }).remaining ?? 0, billing: billingDecision }, { headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
  } catch (err: unknown) {
    if (err instanceof AIRequestGatewayError) {
      logger.info('Live Tutor consume request blocked', {
        status: err.status,
        reason: typeof err.body === 'object' && err.body !== null ? (err.body as Record<string, unknown>).error : 'unknown',
        category: 'live_tutor_consume_blocked',
      });
      return NextResponse.json(err.body, { status: err.status, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error('Live tutor consume failed', { error: message, category: 'live_tutor_consume_error' });
    return NextResponse.json({ error: 'Unable to update the Live Tutor session.' }, { status: 500, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
  }
}
