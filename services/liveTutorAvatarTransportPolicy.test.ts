import { describe, expect, it } from 'vitest';
import { LIVE_TUTOR_AVATAR_TRANSPORTS, resolveLiveTutorAvatarTransport } from './liveTutorAvatarTransportPolicy';

describe('liveTutorAvatarTransportPolicy', () => {
  it('selects LiveKit when the request omits a transport', () => {
    expect(resolveLiveTutorAvatarTransport(null, false)).toEqual({
      ok: true,
      transport: LIVE_TUTOR_AVATAR_TRANSPORTS.liveKit,
    });
  });

  it('rejects unknown transports', () => {
    expect(resolveLiveTutorAvatarTransport('unknown', true)).toEqual({ ok: false, reason: 'invalid_transport' });
  });

  it('rejects client requests for the legacy fallback', () => {
    expect(resolveLiveTutorAvatarTransport(LIVE_TUTOR_AVATAR_TRANSPORTS.legacyWebView, false))
      .toEqual({ ok: false, reason: 'invalid_transport' });
  });

  it('forces the operator-only legacy rollback even when a client requests LiveKit', () => {
    expect(resolveLiveTutorAvatarTransport(LIVE_TUTOR_AVATAR_TRANSPORTS.liveKit, true)).toEqual({
      ok: true,
      transport: LIVE_TUTOR_AVATAR_TRANSPORTS.legacyWebView,
    });
  });
});
