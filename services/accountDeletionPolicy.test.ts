import { describe, expect, it } from 'vitest';
import {
  getAccountDeletionRetryDelayMs,
  isAccountDeletionJobStalled,
  isAccountDeletionRetryDue,
  isIdempotentProviderCancellationError,
} from './accountDeletionPolicy';

describe('account deletion retry policy', () => {
  it('backs off retries and caps the delay at one hour', () => {
    expect(getAccountDeletionRetryDelayMs(1)).toBe(60_000);
    expect(getAccountDeletionRetryDelayMs(3)).toBe(240_000);
    expect(getAccountDeletionRetryDelayMs(20)).toBe(3_600_000);
  });

  it('recognizes due and stalled jobs', () => {
    const now = new Date('2026-08-28T12:00:00.000Z');
    expect(isAccountDeletionRetryDue({ attempts: 2, updatedAt: new Date('2026-08-28T11:57:59.000Z') }, now)).toBe(true);
    expect(isAccountDeletionRetryDue({ attempts: 2, updatedAt: new Date('2026-08-28T11:59:30.000Z') }, now)).toBe(false);
    expect(isAccountDeletionJobStalled({ attempts: 5, createdAt: now }, now)).toBe(true);
  });

  it('treats only known terminal provider states as idempotent success', () => {
    expect(isIdempotentProviderCancellationError({ status: 404 })).toBe(true);
    expect(isIdempotentProviderCancellationError({ statusCode: 410 })).toBe(true);
    expect(isIdempotentProviderCancellationError(new Error('Subscription is already canceled'))).toBe(true);
    expect(isIdempotentProviderCancellationError({ status: 503, message: 'Unavailable' })).toBe(false);
  });
});
