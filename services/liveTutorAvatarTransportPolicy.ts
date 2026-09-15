export const LIVE_TUTOR_AVATAR_TRANSPORTS = {
  current: 'webview-simli',
  liveKitPoc: 'livekit-simli-poc',
} as const;

export type LiveTutorAvatarTransport = typeof LIVE_TUTOR_AVATAR_TRANSPORTS[keyof typeof LIVE_TUTOR_AVATAR_TRANSPORTS];

export type LiveTutorAvatarTransportDecision =
  | { ok: true; transport: LiveTutorAvatarTransport; experimental: boolean }
  | { ok: false; reason: 'invalid_transport' | 'experiment_disabled' };

export function resolveLiveTutorAvatarTransport(
  requested: string | null,
  experimentEnabled = process.env.LIVE_TUTOR_LIVEKIT_POC_ENABLED === 'true',
): LiveTutorAvatarTransportDecision {
  if (requested === null || requested === '' || requested === LIVE_TUTOR_AVATAR_TRANSPORTS.current) {
    return { ok: true, transport: LIVE_TUTOR_AVATAR_TRANSPORTS.current, experimental: false };
  }
  if (requested !== LIVE_TUTOR_AVATAR_TRANSPORTS.liveKitPoc) {
    return { ok: false, reason: 'invalid_transport' };
  }
  return experimentEnabled
    ? { ok: true, transport: LIVE_TUTOR_AVATAR_TRANSPORTS.liveKitPoc, experimental: true }
    : { ok: false, reason: 'experiment_disabled' };
}
