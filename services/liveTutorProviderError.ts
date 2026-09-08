/** Provider credentials belong to the server, not the learner's login session. */
export function liveTutorProviderHttpStatus(providerStatus: number | undefined): number {
  if (providerStatus === 401 || providerStatus === 403) return 503;
  return providerStatus ?? 503;
}
