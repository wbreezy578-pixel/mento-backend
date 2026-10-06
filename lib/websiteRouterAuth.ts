import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_ROUTER_CLOCK_SKEW_SECONDS = 120;

function signedPayload(timestamp: string, nonce: string, pathname: string, hostname: string): string {
  return [timestamp, nonce, 'GET', `${pathname}?hostname=${encodeURIComponent(hostname)}`].join('\n');
}

export function buildWebsiteRouterSignature(input: {
  secret: string;
  timestamp: string;
  nonce: string;
  pathname: string;
  hostname: string;
}): string {
  return createHmac('sha256', input.secret)
    .update(signedPayload(input.timestamp, input.nonce, input.pathname, input.hostname))
    .digest('hex');
}

export async function verifyWebsiteRouterRequest(
  request: Request,
  secret: string,
  now = new Date(),
): Promise<boolean> {
  const timestamp = request.headers.get('x-mento-timestamp')?.trim() ?? '';
  const nonce = request.headers.get('x-mento-nonce')?.trim() ?? '';
  const signature = request.headers.get('x-mento-signature')?.trim() ?? '';
  const hostname = new URL(request.url).searchParams.get('hostname')?.trim().toLowerCase() ?? '';
  if (request.method !== 'GET' || !/^\d{10}$/.test(timestamp) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) return false;
  if (!/^[a-f0-9]{64}$/i.test(signature) || !hostname) return false;
  if (Math.abs(now.getTime() - Number(timestamp) * 1000) > MAX_ROUTER_CLOCK_SKEW_SECONDS * 1000) return false;

  const pathname = new URL(request.url).pathname;
  const expected = buildWebsiteRouterSignature({ secret, timestamp, nonce, pathname, hostname });
  const providedBytes = Buffer.from(signature.toLowerCase(), 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (providedBytes.length !== expectedBytes.length || !timingSafeEqual(providedBytes, expectedBytes)) return false;

  return true;
}
