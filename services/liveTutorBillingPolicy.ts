export function canStartLiveTutorSession(input: { planEnabled: boolean; availableSeconds: number; requestedSeconds: number }): boolean {
  return input.planEnabled
    && Number.isFinite(input.availableSeconds)
    && Number.isFinite(input.requestedSeconds)
    && input.requestedSeconds > 0
    && input.availableSeconds >= input.requestedSeconds;
}
