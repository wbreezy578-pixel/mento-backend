export const LIVE_TUTOR_MAX_SESSION_SECONDS = 20 * 60;
export const LIVE_TUTOR_INACTIVITY_TIMEOUT_MS = 90 * 1000;

export function getLiveTutorMaxSessionSecondsForUser(email?: string | null): number {
  const configuredSeconds = Number.parseInt(process.env.LIVE_TUTOR_TEST_MAX_SESSION_SECONDS ?? '', 10);
  const allowedEmails = (process.env.LIVE_TUTOR_TEST_USER_EMAILS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const normalizedEmail = email?.trim().toLowerCase();
  if (!normalizedEmail || !allowedEmails.includes(normalizedEmail) || !Number.isFinite(configuredSeconds)) {
    return LIVE_TUTOR_MAX_SESSION_SECONDS;
  }
  return Math.max(30, Math.min(LIVE_TUTOR_MAX_SESSION_SECONDS, configuredSeconds));
}

export function clampLiveTutorExpiry(providerExpiry: string | undefined, nowMs = Date.now()): string {
  const appExpiryMs = nowMs + LIVE_TUTOR_MAX_SESSION_SECONDS * 1000;
  const providerExpiryMs = providerExpiry ? Date.parse(providerExpiry) : Number.NaN;
  return new Date(Number.isFinite(providerExpiryMs) ? Math.min(appExpiryMs, providerExpiryMs) : appExpiryMs).toISOString();
}
