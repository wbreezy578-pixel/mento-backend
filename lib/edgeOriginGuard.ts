import { timingSafeEqual } from 'node:crypto';

const EDGE_TOKEN_HEADER = 'x-mento-edge-token';
const PUBLIC_HEALTH_PATHS = new Set(['/api/live', '/api/ready']);

function matchesSecret(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length
    && timingSafeEqual(candidateBuffer, expectedBuffer);
}

export function isEdgeOriginRequestAllowed(
  pathname: string,
  headers: Pick<Headers, 'get'>,
  edgeOriginSecret = process.env.EDGE_ORIGIN_SECRET?.trim() ?? '',
): boolean {
  if (!edgeOriginSecret || PUBLIC_HEALTH_PATHS.has(pathname)) return true;
  return matchesSecret(headers.get(EDGE_TOKEN_HEADER)?.trim() ?? '', edgeOriginSecret);
}
