import { describe, expect, it } from 'vitest';
import { canStartLiveTutorSession } from './liveTutorBillingPolicy';

describe('Live Tutor billing policy', () => {
  it('requires both Pro entitlement and enough wallet seconds', () => {
    expect(canStartLiveTutorSession({ planEnabled: true, availableSeconds: 12000, requestedSeconds: 60 })).toBe(true);
    expect(canStartLiveTutorSession({ planEnabled: false, availableSeconds: 12000, requestedSeconds: 60 })).toBe(false);
    expect(canStartLiveTutorSession({ planEnabled: true, availableSeconds: 0, requestedSeconds: 60 })).toBe(false);
  });
});
