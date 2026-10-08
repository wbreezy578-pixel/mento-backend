import { NextResponse } from 'next/server';

const LEGACY_ROUTE_HEADERS = {
  Deprecation: 'true',
  Sunset: 'Wed, 30 Sep 2026 00:00:00 GMT',
};

/**
 * Legacy Gemini TTS has been retired. Live Tutor uses the active voice
 * transport instead; keep this route as an explicit, build-safe tombstone.
 */
export async function POST() {
  return NextResponse.json(
    { error: 'Legacy Live Tutor TTS has been retired. Use the Live Tutor voice WebSocket.' },
    { status: 410, headers: LEGACY_ROUTE_HEADERS },
  );
}
