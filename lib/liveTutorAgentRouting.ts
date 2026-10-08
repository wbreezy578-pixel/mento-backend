// Keep this aligned with the currently deployed LiveKit worker.  The worker
// is still registered under this name even though the native LiveKit path is
// now the production user path.  Renaming it requires a coordinated worker
// and backend rollout; otherwise dispatch succeeds but no worker claims the
// room and the mobile client eventually times out.
const DEFAULT_LIVE_TUTOR_AGENT_NAME = 'mento-live-tutor-staging';

function configuredEmails(): Set<string> {
  return new Set(
    (process.env.LIVE_TUTOR_CLOUD_AGENT_TEST_USER_EMAILS ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function resolveLiveTutorAgentNameForUser(email?: string | null): string {
  // Every normal session uses the stable production worker.  The optional
  // environment setting is retained for a controlled emergency rollback or
  // a separately named production deployment, but is never gated by email.
  return process.env.LIVE_TUTOR_CLOUD_AGENT_NAME?.trim() || DEFAULT_LIVE_TUTOR_AGENT_NAME;
}

export function isLiveTutorCloudCanaryUser(email?: string | null): boolean {
  const normalizedEmail = email?.trim().toLowerCase();
  return Boolean(normalizedEmail && configuredEmails().has(normalizedEmail));
}

export { DEFAULT_LIVE_TUTOR_AGENT_NAME };
