// Simli treats this as a hard provider disconnect. Keep it comfortably above the
// largest currently sold wallet while still bounding a malformed wallet value.
export const LIVE_TUTOR_MAX_SESSION_SECONDS = 4 * 60 * 60;
export const LIVE_TUTOR_INACTIVITY_TIMEOUT_MS = 90 * 1000;

export function getLiveTutorMaxSessionSecondsForUser(email?: string | null): number {
  void email;
  return LIVE_TUTOR_MAX_SESSION_SECONDS;
}

export function clampLiveTutorExpiry(providerExpiry: string | undefined, nowMs = Date.now(), authorizedSeconds = LIVE_TUTOR_MAX_SESSION_SECONDS): string {
  const appExpiryMs = nowMs + Math.max(1, Math.min(LIVE_TUTOR_MAX_SESSION_SECONDS, authorizedSeconds)) * 1000;
  const providerExpiryMs = providerExpiry ? Date.parse(providerExpiry) : Number.NaN;
  return new Date(Number.isFinite(providerExpiryMs) ? Math.min(appExpiryMs, providerExpiryMs) : appExpiryMs).toISOString();
}
