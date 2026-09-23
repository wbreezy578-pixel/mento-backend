import { sanitizeForLogging } from './sanitize';

function timestamp() {
  return new Date().toISOString();
}

function safeStringify(obj: unknown) {
  try {
    return JSON.stringify(sanitizeForLogging(obj));
  } catch {
    return String(sanitizeForLogging(obj));
  }
}

function emit(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) {
  const configuredLevel = process.env.LOG_LEVEL?.trim().toLowerCase();
  const minimumLevel = configuredLevel === 'info' || configuredLevel === 'warn' || configuredLevel === 'error'
    ? configuredLevel
    : process.env.NODE_ENV === 'production' ? 'warn' : 'info';
  const weights = { info: 10, warn: 20, error: 30 } as const;
  if (weights[level] < weights[minimumLevel]) return;
  const out = { ts: timestamp(), level, message, meta: meta ? sanitizeForLogging(meta) : undefined };
  if (level === 'warn') {
    console.warn(safeStringify(out));
    return;
  }
  if (level === 'error') {
    console.error(safeStringify(out));
    return;
  }
  console.log(safeStringify(out));
}

export function info(message: string, meta?: Record<string, unknown>) {
  emit('info', message, meta);
}

export function warn(message: string, meta?: Record<string, unknown>) {
  emit('warn', message, meta);
}

export function error(message: string, meta?: Record<string, unknown>) {
  emit('error', message, meta);
}

const loggerApi = { info, warn, error };

export async function flush(): Promise<void> {
  const runtimeProcess = (globalThis as typeof globalThis & {
    process?: { stdout?: NodeJS.WriteStream; stderr?: NodeJS.WriteStream };
  }).process;
  if (!runtimeProcess?.stdout || !runtimeProcess.stderr) return;

  await Promise.all([flushStream(runtimeProcess.stdout), flushStream(runtimeProcess.stderr)]);
}

function flushStream(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.writableNeedDrain || stream.writableLength > 0) {
      stream.write('', () => resolve());
      return;
    }
    resolve();
  });
}

const loggerWithFlush = { ...loggerApi, flush };

export default loggerWithFlush;
