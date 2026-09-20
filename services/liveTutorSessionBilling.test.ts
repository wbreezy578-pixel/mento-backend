import { describe, expect, it } from 'vitest';
import { resolveLiveTutorFinalizationUsage } from './liveTutorSessionBilling';

describe('Live Tutor terminal billing usage', () => {
  it('records a failed startup as zero charged seconds even if its observed duration reached the reservation cap', () => {
    expect(resolveLiveTutorFinalizationUsage({
      secondsReserved: 1_800,
      durableSecondsConsumed: 1_800,
      elapsedSeconds: 1_800,
      clientReportedSeconds: 1_800,
      usable: false,
      status: 'failed',
    })).toEqual({
      observedSeconds: 1_800,
      chargedSeconds: 0,
      rollbackRequired: true,
      rollbackAmount: 1,
    });
  });

  it('rolls back a failed usable session rather than recording a spend', () => {
    expect(resolveLiveTutorFinalizationUsage({
      secondsReserved: 600,
      durableSecondsConsumed: 300,
      elapsedSeconds: 301,
      clientReportedSeconds: 500,
      usable: true,
      status: 'failed',
    })).toMatchObject({ observedSeconds: 500, chargedSeconds: 0, rollbackRequired: true, rollbackAmount: 500 });
  });

  it('charges only a successful usable session and caps it at its reservation', () => {
    expect(resolveLiveTutorFinalizationUsage({
      secondsReserved: 60,
      durableSecondsConsumed: 10,
      elapsedSeconds: 65,
      clientReportedSeconds: 0,
      usable: true,
      status: 'completed',
    })).toMatchObject({ observedSeconds: 60, chargedSeconds: 60, rollbackRequired: false });
  });
});
