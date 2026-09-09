# Mento production-readiness checklist

This checklist tracks the release blockers found in the September 2026 backend, mobile, Azure, and Googlebot audit.

## Phase 0 — Canonical deployment and crawler surface

- [ ] Choose one public canonical web origin and align DNS, `AUTH_WEB_BASE_URL`, mobile API configuration, checkout URLs, robots, and sitemap.
- [x] Generate absolute sitemap URLs from the configured canonical origin.
- [x] Make the robots sitemap reference absolute and canonical.
- [x] Stop emitting a changing `lastModified` timestamp on every sitemap request.
- [ ] Deploy the crawler changes to the canonical origin and verify Googlebot responses there.

## Phase 1 — Release gates

- [x] Fix the backend lint error.
- [x] Resolve Expo Doctor configuration, icon, and SDK-version findings.
- [x] Patch backend Next.js and `sharp` runtime advisories.
- [x] Patch the mobile XML parser advisory.
- [ ] Review the remaining moderate transitive navigation and query-string advisories; current audit reports no safe automatic fix.
- [ ] Run backend and mobile checks from clean release commits.
- [ ] Build and install the matching Android release artifact.

## Phase 2 — Deployment correctness and data safety

- [ ] Commit and push the intended backend and mobile changes without temporary logs or build artifacts.
- [ ] Deploy the exact backend commit and record its image digest and revision.
- [ ] Verify Prisma migration status against the Azure database using `DIRECT_URL`.
- [ ] Smoke-test authentication, normal Gemini chat, image analysis, Live Tutor, and payment callbacks.
- [ ] Remove or explicitly gate test-only Live Tutor limits and test-user overrides.

## Phase 3 — Runtime resilience and security

- [ ] Replace or harden in-memory Live Tutor session state for restart and multi-replica recovery.
- [ ] Move Azure to a deliberate replica/revision strategy with rollback validation.
- [x] Restrict detailed dependency diagnostics to authenticated operators when the metrics token is configured.
- [x] Limit unauthenticated readiness responses to aggregate status while preserving Azure probe compatibility.
- [ ] Add alerts for provider failures, reconnects, audio underruns, stale packets, and failed payments.
- [ ] Verify backups, restore procedure, secret rotation, and incident rollback.

## Phase 4 — Google and mobile launch validation

- [ ] Submit the canonical sitemap in Google Search Console.
- [ ] Verify mobile rendering, legal-page indexing, canonical tags, and intentional noindex routes.
- [ ] Run Android tests on speakerphone, headphones, background/foreground, reconnect, interruption, and exhausted Live Tutor minutes.
- [ ] Complete a Play internal test before public release.
