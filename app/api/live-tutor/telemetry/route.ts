import { NextResponse } from 'next/server';
import { authenticateAIRequest } from '../../../../lib/aiSecurityGateway';
import { buildCorsHeaders } from '../../../../lib/securityHeaders';
import { getOwnedActiveLiveTutorSession } from '../../../../services/simliService';
import { observeLiveTutorAvatarAvOffset, recordLiveTutorSessionEvent } from '../../../../lib/metrics';

const CORS_METHODS = 'POST, OPTIONS';
const EVENTS = new Set(['connection_success', 'first_avatar_audio', 'reconnect', 'connection_failed']);

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
}

export async function POST(req: Request) {
  const headers = { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS };
  try {
    const user = await authenticateAIRequest(req);
    const body = await req.json() as { streamId?: unknown; event?: unknown; transport?: unknown; avOffsetMs?: unknown };
    const streamId = typeof body.streamId === 'string' ? body.streamId.trim() : '';
    const event = typeof body.event === 'string' && EVENTS.has(body.event) ? body.event : null;
    const transport = body.transport === 'livekit' ? 'livekit' : '';
    const avOffsetMs = typeof body.avOffsetMs === 'number' && Number.isFinite(body.avOffsetMs) && Math.abs(body.avOffsetMs) <= 10_000
      ? body.avOffsetMs
      : null;
    if (!streamId || !transport || (!event && avOffsetMs === null)) {
      return NextResponse.json({ error: 'Invalid Live Tutor telemetry.' }, { status: 400, headers });
    }
    const ownedSession = await getOwnedActiveLiveTutorSession(user.id, streamId);
    if (!ownedSession) return NextResponse.json({ error: 'Live Tutor session is not active.' }, { status: 403, headers });

    if (event) recordLiveTutorSessionEvent(event as 'connection_success' | 'first_avatar_audio' | 'reconnect' | 'connection_failed', transport);
    if (avOffsetMs !== null) observeLiveTutorAvatarAvOffset(avOffsetMs, transport);
    return NextResponse.json({ ok: true }, { headers });
  } catch {
    return NextResponse.json({ error: 'Unable to record Live Tutor telemetry.' }, { status: 500, headers });
  }
}
