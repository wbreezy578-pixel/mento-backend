const MINUTE_MS = 60_000;
const MAX_RETRY_DELAY_MS = 60 * MINUTE_MS;

export type AccountDeletionFailureCode =
  | 'paddle_cancel_failed'
  | 'google_play_cancel_failed'
  | 'supabase_delete_failed'
  | 'internal_delete_failed';

export function getAccountDeletionRetryDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(6, Math.floor(attempts) - 1));
  return Math.min(MAX_RETRY_DELAY_MS, MINUTE_MS * (2 ** exponent));
}

export function isAccountDeletionRetryDue(input: { attempts: number; updatedAt: Date }, now = new Date()): boolean {
  return now.getTime() - input.updatedAt.getTime() >= getAccountDeletionRetryDelayMs(input.attempts);
}

export function isAccountDeletionJobStalled(input: { attempts: number; createdAt: Date }, now = new Date()): boolean {
  return input.attempts >= 5 || now.getTime() - input.createdAt.getTime() >= 24 * 60 * MINUTE_MS;
}

export function isIdempotentProviderCancellationError(error: unknown): boolean {
  const candidate = error as { status?: unknown; statusCode?: unknown; message?: unknown; idempotentTerminal?: unknown } | null;
  if (candidate?.idempotentTerminal === true) return true;
  const status = Number(candidate?.status ?? candidate?.statusCode);
  if (status === 404 || status === 410) return true;
  const text = String(candidate?.message ?? '').toLowerCase();
  return /already (?:cancelled|canceled|deleted)|subscription (?:is )?(?:cancelled|canceled)|not found/.test(text);
}
