import { describe, expect, it } from 'vitest';
import {
  metricsText,
  observeLiveTutorAvatarAvOffset,
  recordLiveTutorMinutesDeducted,
  recordLiveTutorSessionEvent,
} from './metrics';

describe('Live Tutor production metrics', () => {
  it('exposes aggregate connection, lip-sync, and committed-minute metrics', async () => {
    recordLiveTutorSessionEvent('connection_success');
    recordLiveTutorSessionEvent('first_avatar_audio');
    recordLiveTutorSessionEvent('reconnect');
    observeLiveTutorAvatarAvOffset(-92);
    recordLiveTutorMinutesDeducted(120, 'completed');

    const output = await metricsText();
    expect(output).toContain('live_tutor_session_events_total');
    expect(output).toContain('live_tutor_avatar_av_offset_ms');
    expect(output).toContain('live_tutor_minutes_deducted_total');
  });
});
