const REVIEW_EMAIL_ENV = 'GOOGLE_PLAY_REVIEW_EMAIL';
const REVIEW_MFA_BYPASS_ENV = 'GOOGLE_PLAY_REVIEW_MFA_BYPASS';

export function isGooglePlayReviewAccount(email: string | null | undefined): boolean {
  const configuredEmail = process.env[REVIEW_EMAIL_ENV]?.trim().toLowerCase();
  return process.env[REVIEW_MFA_BYPASS_ENV] === 'true'
    && Boolean(configuredEmail)
    && email?.trim().toLowerCase() === configuredEmail;
}