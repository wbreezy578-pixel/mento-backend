const DEFAULT_LIVE_TUTOR_AGENT_NAME = 'mento-live-tutor-staging';

function configuredEmails(): Set<string> {
  return new Set(
    (process.env.LIVE_TUTOR_CLOUD_AGENT_TEST_USER_EMAILS ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * A deliberately narrow, server-owned canary. Clients cannot select an agent;
 * production Cloud routing is enabled only for an explicitly configured user.
 */
export function resolveLiveTutorAgentNameForUser(email?: string | null): string {
  const productionAgentName = process.env.LIVE_TUTOR_CLOUD_AGENT_NAME?.trim();

  if (productionAgentName && isLiveTutorCloudCanaryUser(email)) return productionAgentName;

  return DEFAULT_LIVE_TUTOR_AGENT_NAME;
}

export function isLiveTutorCloudCanaryUser(email?: string | null): boolean {
  const normalizedEmail = email?.trim().toLowerCase();
  return Boolean(process.env.LIVE_TUTOR_CLOUD_AGENT_NAME?.trim() && normalizedEmail && configuredEmails().has(normalizedEmail));
}

export { DEFAULT_LIVE_TUTOR_AGENT_NAME };
