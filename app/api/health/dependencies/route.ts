import { NextResponse } from 'next/server';
import { getGeminiApiKey, getSimliApiBaseUrl, getSimliApiKey } from '../../../../lib/env';
import { getCircuitBreaker } from '../../../../lib/resilience';

const CACHE_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_500;

type ProbeResult = {
  status: 'ok' | 'fail';
  statusCode?: number;
  latencyMs: number;
  checkedAt: string;
};

let cached: { expiresAt: number; value: Record<string, unknown> } | null = null;

async function probe(url: string, init?: RequestInit): Promise<ProbeResult> {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      ...init,
      cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return {
      status: response.ok ? 'ok' : 'fail',
      statusCode: response.status,
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
    };
  } catch {
    return {
      status: 'fail',
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
    };
  }
}

export async function GET() {
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json({ ...cached.value, cached: true });
  }

  const geminiKey = getGeminiApiKey();
  const simliKey = getSimliApiKey();
  const [gemini, simli] = await Promise.all([
    probe(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(geminiKey)}`),
    probe(`${getSimliApiBaseUrl()}/compose/ice`, {
      headers: { 'x-simli-api-key': simliKey },
    }),
  ]);

  const geminiBreaker = getCircuitBreaker('gemini', 5, 30_000);
  const simliBreaker = getCircuitBreaker('simli', 3, 30_000);
  const value = {
    status: gemini.status === 'ok' && simli.status === 'ok' ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    dependencies: {
      gemini: { ...gemini, circuitState: geminiBreaker.getState() },
      simli: { ...simli, circuitState: simliBreaker.getState() },
    },
  };
  cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };

  return NextResponse.json(value, {
    status: value.status === 'healthy' ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
