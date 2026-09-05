import { describe, expect, it } from 'vitest';
import { validateLegalAcceptance } from './legalConsent';
import { CURRENT_LEGAL_VERSIONS } from './legalVersions';

describe('legal acceptance', () => {
  it('requires an explicit 18+ declaration', () => {
    expect(validateLegalAcceptance({ ageConfirmed: false, legalVersions: CURRENT_LEGAL_VERSIONS })).toMatch(/18/);
  });

  it('rejects stale legal versions', () => {
    expect(validateLegalAcceptance({ ageConfirmed: true, legalVersions: { ...CURRENT_LEGAL_VERSIONS, terms: 'old' } })).toMatch(/current/);
  });

  it('accepts the current version set', () => {
    expect(validateLegalAcceptance({ ageConfirmed: true, legalVersions: CURRENT_LEGAL_VERSIONS })).toBeNull();
  });
});
