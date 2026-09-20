export type LiveTutorTerminalStatus = 'completed' | 'failed' | 'disconnected';

export interface LiveTutorFinalizationUsageInput {
  secondsReserved: number;
  durableSecondsConsumed: number;
  elapsedSeconds: number;
  clientReportedSeconds: number;
  usable: boolean;
  status: LiveTutorTerminalStatus;
}

/**
 * Separates elapsed/observed time from debit-authoritative time. A failed
 * session is rolled back by policy, so it must never be reported or persisted
 * as consuming its reservation merely because it reached a duration cap.
 */
export function resolveLiveTutorFinalizationUsage(input: LiveTutorFinalizationUsageInput) {
  const secondsReserved = Math.max(0, Math.floor(input.secondsReserved));
  const observedSeconds = Math.min(
    secondsReserved,
    Math.max(
      0,
      Math.floor(input.durableSecondsConsumed),
      Math.floor(input.elapsedSeconds),
      Math.floor(input.clientReportedSeconds),
    ),
  );
  const rollbackRequired = !input.usable || input.status === 'failed';

  return {
    observedSeconds,
    chargedSeconds: rollbackRequired ? 0 : Math.max(1, observedSeconds),
    rollbackRequired,
    // rollbackUsage is idempotent cleanup of an existing pending record. Keep
    // its historical minimum amount without treating that value as a debit.
    rollbackAmount: input.usable ? Math.max(1, observedSeconds) : 1,
  };
}
