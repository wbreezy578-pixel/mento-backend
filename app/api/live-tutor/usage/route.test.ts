import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { recordUsage } = vi.hoisted(() => ({ recordUsage: vi.fn() }));

vi.mock('../../../../services/liveTutorRealtimeVoiceUsageService', () => ({
  recordLiveTutorRealtimeVoiceUsage: recordUsage,
}));

import { POST } from './route';

const usage = {
  responseId: 'resp_123',
  model: 'gpt-realtime',
  inputTokens: 1_000,
  outputTokens: 300,
  totalTokens: 1_300,
  inputAudioTokens: 400,
  inputTextTokens: 600,
  inputImageTokens: 0,
  cachedInputTokens: 100,
  outputAudioTokens: 100,
  outputTextTokens: 200,
  cancelled: false,
  timestampMs: 1_700_000_000_000,
  durationMs: 1_200,
  ttftMs: 240,
};

function createRequest(body: unknown, secret = 'worker-secret'): Request {
  return new Request('https://mento.test/api/live-tutor/usage', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mento-live-tutor-worker-secret': secret },
    body: JSON.stringify(body),
  });
}

describe('Live Tutor Realtime usage endpoint', () => {
  beforeEach(() => {
    vi.stubEnv('MENTO_LIVE_TUTOR_WORKER_CALLBACK_SECRET', 'worker-secret');
    recordUsage.mockReset().mockResolvedValue(true);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('rejects callers without the worker secret', async () => {
    const response = await POST(createRequest({ streamId: 'stream-1', usage }, 'wrong-secret'));

    expect(response.status).toBe(401);
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('records valid provider-reported response metrics for the session', async () => {
    const response = await POST(createRequest({ streamId: 'stream-1', usage }));

    expect(response.status).toBe(200);
    expect(recordUsage).toHaveBeenCalledWith({ streamId: 'stream-1', usage });
  });

  it('rejects malformed token metrics before persistence', async () => {
    const response = await POST(createRequest({ streamId: 'stream-1', usage: { ...usage, outputAudioTokens: -1 } }));

    expect(response.status).toBe(400);
    expect(recordUsage).not.toHaveBeenCalled();
  });
});