import { CURRENT_LEGAL_VERSIONS } from './legalVersions';

export type LegalAcceptanceInput = {
  ageConfirmed?: unknown;
  legalVersions?: { privacy?: unknown; terms?: unknown; aiNotice?: unknown } | null;
};

export function validateLegalAcceptance(input: LegalAcceptanceInput): string | null {
  if (input.ageConfirmed !== true) return 'You must confirm that you are at least 18 years old.';
  const versions = input.legalVersions;
  if (versions?.privacy !== CURRENT_LEGAL_VERSIONS.privacy || versions?.terms !== CURRENT_LEGAL_VERSIONS.terms || versions?.aiNotice !== CURRENT_LEGAL_VERSIONS.aiNotice) {
    return 'Please review and accept the current Privacy Policy, Terms, and AI notice.';
  }
  return null;
}
