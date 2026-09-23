export class RequestBodyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413,
    readonly code: 'invalid_json' | 'request_too_large',
  ) {
    super(message);
    this.name = 'RequestBodyError';
  }
}

function parseContentLength(request: Request): number | null {
  const raw = request.headers.get('content-length');
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export async function readJsonBodyWithLimit<T>(request: Request, maxBytes: number): Promise<T> {
  const contentLength = parseContentLength(request);
  if (contentLength !== null && contentLength > maxBytes) {
    throw new RequestBodyError('Request body is too large.', 413, 'request_too_large');
  }

  if (!request.body) {
    throw new RequestBodyError('Invalid JSON body.', 400, 'invalid_json');
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel('request-too-large').catch(() => undefined);
        throw new RequestBodyError('Request body is too large.', 413, 'request_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(merged)) as T;
  } catch {
    throw new RequestBodyError('Invalid JSON body.', 400, 'invalid_json');
  }
}

export function assertRequestContentLength(request: Request, maxBytes: number): void {
  const contentLength = parseContentLength(request);
  if (contentLength !== null && contentLength > maxBytes) {
    throw new RequestBodyError('Request body is too large.', 413, 'request_too_large');
  }
}
