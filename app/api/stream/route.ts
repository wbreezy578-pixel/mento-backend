import { NextResponse } from 'next/server';
import { createSimliStreamingAvatarSession, closeRealtimeSession, getActiveSimliSessionForUser } from '../../../services/simliService';
import {
  AIRequestGatewayError,
  authenticateAIRequest,
  enforceAIGatewayRateLimit,
  executeAIRequest,
  getClientIp,
  buildAIRequestId,
} from '../../../lib/aiSecurityGateway';
import logger from '../../../lib/logger';

export async function POST(req: Request) {
  try {
    const user = await authenticateAIRequest(req);
    const clientIp = getClientIp(req);
    await enforceAIGatewayRateLimit(user.id, clientIp);

    const existingSession = getActiveSimliSessionForUser(user.id);
    if (existingSession?.streamId) {
      return NextResponse.json({
        sessionToken: existingSession.sessionToken,
        streamId: existingSession.streamId,
        sessionId: existingSession.sessionId,
        avatarId: existingSession.avatarId,
        expiresAt: existingSession.expiresAt,
      });
    }

    const requestId = buildAIRequestId('live-stream');
    const { result: session, billingDecision } = await executeAIRequest({
      user,
      clientIp,
      feature: 'live_tutor',
      provider: 'Simli',
      amount: 60,
      requestId,
      metadata: { streamType: 'avatar-session' },
      pending: true,
      callback: async () => await createSimliStreamingAvatarSession({ requestId, userId: user.id, secondsReserved: 60 }),
    });

    if (billingDecision.remainingUsage !== null && billingDecision.remainingUsage <= 0) {
      try {
        await closeRealtimeSession(session.streamId).catch(() => undefined);
      } catch {
        // ignore cleanup errors
      }
    }

    return NextResponse.json({ ...session, billing: billingDecision });
  } catch (error: unknown) {
    if (error instanceof AIRequestGatewayError) {
      return NextResponse.json(error.body, { status: error.status });
    }

    const message = error instanceof Error ? error.message : 'Internal connection failure';
    const status = (error as { status?: number })?.status ?? 500;
    logger.error('Live avatar token generation failed', { error: message });
    return NextResponse.json({ error: message }, { status });
  }
}
