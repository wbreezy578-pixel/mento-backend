import { describe, expect, it } from 'vitest';
import { LIVE_TUTOR_AVATAR_TRANSPORTS, resolveLiveTutorAvatarTransport } from './liveTutorAvatarTransportPolicy';

describe('liveTutorAvatarTransportPolicy', () => {
  it('selects the current path when the request omits a transport', () => {
    expect(resolveLiveTutorAvatarTransport(null, false)).toEqual({
      ok: true,
      transport: LIVE_TUTOR_AVATAR_TRANSPORTS.current,
      experimental: false,
    });
  });

  it('rejects unknown transports', () => {
    expect(resolveLiveTutorAvatarTransport('unknown', true)).toEqual({ ok: false, reason: 'invalid_transport' });
  });

  it('rejects the proof of concept while its server gate is disabled', () => {
    expect(resolveLiveTutorAvatarTransport(LIVE_TUTOR_AVATAR_TRANSPORTS.liveKitPoc, false))
      .toEqual({ ok: false, reason: 'experiment_disabled' });
  });

  it('allows only the explicit proof-of-concept transport when its server gate is enabled', () => {
    expect(resolveLiveTutorAvatarTransport(LIVE_TUTOR_AVATAR_TRANSPORTS.liveKitPoc, true)).toEqual({
      ok: true,
      transport: LIVE_TUTOR_AVATAR_TRANSPORTS.liveKitPoc,
      experimental: true,
    });
  });
});
