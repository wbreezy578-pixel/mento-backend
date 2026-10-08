import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { recordLiveTutorRealtimeVoiceUsage } from '../../../../services/liveTutorRealtimeVoiceUsageService';
import type { LiveTutorRealtimeVoiceUsageSnapshot } from '../../../../services/liveTutorRealtimeVoiceUsage';

export const runtime = 'nodejs';

function hasValidWorkerSecret(request: Request): boolean {
  const expected = process.env.MENTO_LIVE_TUTOR_WORKER_CALLBACK_SECRET?.trim();
  const supplied = request.headers.get('x-mento-live-tutor-worker-secret')?.trim();
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseUsage(value: unknown): LiveTutorRealtimeVoiceUsageSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usage = value as Record<string, unknown>;
  if (
    typeof usage.responseId !== 'string' || !usage.responseId.trim() || usage.responseId.length > 200
    || typeof usage.model !== 'string' || !usage.model.trim() || usage.model.length > 100
    || !isNonNegativeInt(usage.inputTokens)
    || !isNonNegativeInt(usage.outputTokens)
    || !isNonNegativeInt(usage.totalTokens)
    || !isNonNegativeInt(usage.inputAudioTokens)
    || !isNonNegativeInt(usage.inputTextTokens)
    || !isNonNegativeInt(usage.inputImageTokens)
    || !isNonNegativeInt(usage.cachedInputTokens)
    || !isNonNegativeInt(usage.outputAudioTokens)
    || !isNonNegativeInt(usage.outputTextTokens)
    || typeof usage.cancelled !== 'boolean'
    || !isSafeNonNegativeInteger(usage.timestampMs)
    || !isNonNegativeInt(usage.durationMs)
    || typeof usage.ttftMs !== 'number' || !Number.isSafeInteger(usage.ttftMs) || usage.ttftMs < -1 || usage.ttftMs > 2_147_483_647
  ) return null;

  return usage as LiveTutorRealtimeVoiceUsageSnapshot;
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!hasValidWorkerSecret(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Invalid usage payload.' }, { status: 400 });
  const payload = body as Record<string, unknown>;
  const streamId = typeof payload.streamId === 'string' ? payload.streamId.trim() : '';
  const usage = parseUsage(payload.usage);
  if (!streamId || streamId.length > 200 || !usage) return NextResponse.json({ error: 'Invalid usage payload.' }, { status: 400 });

  const recorded = await recordLiveTutorRealtimeVoiceUsage({ streamId, usage });
  if (!recorded) return NextResponse.json({ error: 'Live Tutor session not found.' }, { status: 404 });
  return NextResponse.json({ ok: true });
}