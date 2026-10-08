import { describe, expect, it } from 'vitest';
import { readJsonBodyWithLimit, RequestBodyError } from './requestBody';

describe('bounded JSON request parsing', () => {
  it('parses JSON within the configured byte limit', async () => {
    const request = new Request('https://mento.test/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });

    await expect(readJsonBodyWithLimit<{ message: string }>(request, 1_024)).resolves.toEqual({ message: 'hello' });
  });

  it('rejects an oversized body before parsing application fields', async () => {
    const request = new Request('https://mento.test/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'x'.repeat(2_000) }),
    });

    await expect(readJsonBodyWithLimit(request, 512)).rejects.toMatchObject({
      status: 413,
      code: 'request_too_large',
    } satisfies Partial<RequestBodyError>);
  });

  it('returns a controlled error for malformed JSON', async () => {
    const request = new Request('https://mento.test/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });

    await expect(readJsonBodyWithLimit(request, 1_024)).rejects.toMatchObject({
      status: 400,
      code: 'invalid_json',
    } satisfies Partial<RequestBodyError>);
  });
});
