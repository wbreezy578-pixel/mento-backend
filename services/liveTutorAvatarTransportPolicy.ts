export const LIVE_TUTOR_AVATAR_TRANSPORTS = {
  liveKit: 'livekit-simli',
  legacyWebView: 'webview-simli',
} as const;

export type LiveTutorAvatarTransport = typeof LIVE_TUTOR_AVATAR_TRANSPORTS[keyof typeof LIVE_TUTOR_AVATAR_TRANSPORTS];

export type LiveTutorAvatarTransportDecision =
  | { ok: true; transport: LiveTutorAvatarTransport }
  | { ok: false; reason: 'invalid_transport' };

export function resolveLiveTutorAvatarTransport(
  requested: string | null,
  legacyRollbackEnabled = process.env.LIVE_TUTOR_LEGACY_WEBVIEW_ROLLBACK_ENABLED === 'true',
): LiveTutorAvatarTransportDecision {
  // LiveKit is the standard transport. The legacy WebView route can only be
  // re-enabled by an operator for a release rollback; clients cannot select it.
  if (requested !== null && requested !== '' && requested !== LIVE_TUTOR_AVATAR_TRANSPORTS.liveKit) {
    return { ok: false, reason: 'invalid_transport' };
  }
  return {
    ok: true,
    transport: legacyRollbackEnabled ? LIVE_TUTOR_AVATAR_TRANSPORTS.legacyWebView : LIVE_TUTOR_AVATAR_TRANSPORTS.liveKit,
  };
}
