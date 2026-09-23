import { createHmac, timingSafeEqual } from 'node:crypto';
import { ensureCooldown } from './rateLimiter';

export const INTERNAL_JOB_MAX_CLOCK_SKEW_SECONDS = 300;

function signaturePayload(timestamp: string, nonce: string, method: string, pathname: string): string {
  return [timestamp, nonce, method.toUpperCase(), pathname].join('\n');
}

export function buildInternalJobSignature(
  secret: string,
  input: { timestamp: string; nonce: string; method: string; pathname: string },
): string {
  return createHmac('sha256', secret)
    .update(signaturePayload(input.timestamp, input.nonce, input.method, input.pathname))
    .digest('hex');
}

function signaturesMatch(provided: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(provided)) return false;
  const left = Buffer.from(provided.toLowerCase(), 'utf8');
  const right = Buffer.from(expected.toLowerCase(), 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function verifyInternalJobRequest(
  req: Request,
  secret: string,
  now = new Date(),
): Promise<{ ok: true } | { ok: false; reason: 'invalid' | 'expired' | 'replayed' }> {
  const timestamp = req.headers.get('x-mento-timestamp')?.trim() ?? '';
  const nonce = req.headers.get('x-mento-nonce')?.trim() ?? '';
  const signature = req.headers.get('x-mento-signature')?.trim() ?? '';
  const timestampSeconds = Number(timestamp);

  if (!/^\d{10,13}$/.test(timestamp) || !Number.isSafeInteger(timestampSeconds)) return { ok: false, reason: 'invalid' };
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) return { ok: false, reason: 'invalid' };

  // Accept either Unix seconds (10 digits) or Unix milliseconds (13 digits).
  // The scheduler examples use seconds, while some platform job runners emit
  // millisecond timestamps. Treating milliseconds as seconds would reject every
  // otherwise valid request as expired.
  const requestTimeMs = timestamp.length >= 13 ? timestampSeconds : timestampSeconds * 1000;
  if (Math.abs(now.getTime() - requestTimeMs) > INTERNAL_JOB_MAX_CLOCK_SKEW_SECONDS * 1000) {
    return { ok: false, reason: 'expired' };
  }

  const pathname = new URL(req.url).pathname;
  const expected = buildInternalJobSignature(secret, {
    timestamp,
    nonce,
    method: req.method,
    pathname,
  });
  if (!signaturesMatch(signature, expected)) return { ok: false, reason: 'invalid' };

  const replayClaim = await ensureCooldown(
    `internal-job:${nonce}`,
    (INTERNAL_JOB_MAX_CLOCK_SKEW_SECONDS * 2 + 60) * 1000,
  );
  if (!replayClaim.ok) return { ok: false, reason: 'replayed' };
  return { ok: true };
}
