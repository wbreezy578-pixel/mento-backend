export const LIVE_TUTOR_MAX_SESSION_SECONDS = 20 * 60;
export const LIVE_TUTOR_INACTIVITY_TIMEOUT_MS = 90 * 1000;

export function clampLiveTutorExpiry(providerExpiry: string | undefined, nowMs = Date.now()): string {
  const appExpiryMs = nowMs + LIVE_TUTOR_MAX_SESSION_SECONDS * 1000;
  const providerExpiryMs = providerExpiry ? Date.parse(providerExpiry) : Number.NaN;
  return new Date(Number.isFinite(providerExpiryMs) ? Math.min(appExpiryMs, providerExpiryMs) : appExpiryMs).toISOString();
}
