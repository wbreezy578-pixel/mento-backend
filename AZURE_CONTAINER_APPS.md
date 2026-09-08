# Azure Container Apps foundation

This phase deploys the existing custom Node server to Azure Container Apps with external HTTPS ingress on port 3000. The custom WebSocket gateway is attached by `server.ts` and uses the same process as the Next.js application.

## Build

Build the self-contained backend image from the backend repository:

```text
cd mento
docker build -t YOUR_REGISTRY/mento:TAG .
docker push YOUR_REGISTRY/mento:TAG
```

## Infrastructure

Copy `infra/main.parameters.example.json` to a private parameters file. Replace every placeholder through a secure deployment mechanism. Do not commit the private file or place real credentials in source control.

Deploy `infra/main.bicep` to an existing resource group with Azure CLI or the Azure Developer CLI. The deployment outputs the Container Apps fully qualified domain name.

Run database migrations as a separate release step before updating the application image:

```text
npm run migrate:deploy
```

Application startup intentionally does not run migrations. This prevents ordinary restarts or replica startup from competing for schema changes.

## Production billing configuration

The active production billing model for Mento is native mobile billing through Google Play for Android and App Store for iOS. Legacy Paddle values are intentionally not part of the current production configuration.

Android launch requires these Azure values in addition to the core database, Redis, Gemini, Supabase, and Simli settings:

- `GOOGLE_PLAY_WIF_CONFIG_JSON`: preferred Google external-account credential configuration generated for the Azure Container App managed identity; store as a Container App secret.
- `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`: backwards-compatible fallback containing the complete JSON for the Play Console-linked service account; store as a Container App secret when WIF is unavailable.
- The backend prefers `GOOGLE_PLAY_WIF_CONFIG_JSON` when both credentials are present.
- `GOOGLE_PLAY_RTDN_AUDIENCE`: the exact public RTDN endpoint URL, ending in `/api/payments/mobile/google-rtdn`.
- `GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL`: the service identity configured on the Pub/Sub push subscription.

The Play products must use the exact IDs `mento_pro_monthly`, `mento_live_tutor_50`, and `mento_live_tutor_100`.

Before an iOS launch, also set `APPLE_ROOT_CERTIFICATES_BASE64` and the numeric `APPLE_APP_ID`, then configure App Store Server Notifications to `/api/payments/mobile/apple-notifications`.

Do not configure Paddle API keys, Paddle webhook secrets, or Paddle price IDs for the current alpha release. Those settings are historical and not used by the live Android flow.

## Authentication and deletion operations

Production authentication also requires `RESEND_API_KEY`, `AUTH_EMAIL_FROM`, and `AUTH_WEB_BASE_URL`. The sender must use a verified Resend domain and the web base URL must be HTTPS. `RETENTION_JOB_SECRET` protects both internal maintenance endpoints; callers must send a short-lived HMAC signature using `x-mento-timestamp`, `x-mento-nonce`, and `x-mento-signature` (the signature covers timestamp, nonce, HTTP method, and pathname). Keep these routes network-restricted and never expose the secret in the mobile application.

Account deletion first revokes every session and marks the user as deletion-pending. Paddle, Google Play, Supabase Auth, and local data cleanup are checkpointed in `AccountDeletionJob`, so provider or process failures can be retried safely. Invoke `POST /api/internal/account-deletions` from a protected scheduled job at least every 15 minutes with a fresh HMAC signature (see the headers above). Nonces are single-use and signatures expire after five minutes. Never expose this endpoint or secret in the mobile application.

## Current scope

- Persistent Node process
- HTTPS ingress with WebSocket-compatible transport
- Log Analytics application logs
- Parameterized secrets
- Exactly one replica for the voice server. The Bicep deployment enforces this with fixed `minReplicas: 1` and `maxReplicas: 1`; Gemini Live connections are process-local and cannot be safely load-balanced between replicas.

Redis-backed lease coordination is supported, but it does not make the live Gemini connection portable between processes. Production startup also fails before listening if realtime Redis is missing or unhealthy, so `REQUIRE_REALTIME_REDIS=true` and a healthy `REDIS_URL` are required. Multi-replica voice hosting requires a dedicated realtime worker/session service and is not enabled by this deployment.

For a controlled countdown test, set `LIVE_TUTOR_TEST_MAX_SESSION_SECONDS=120` together with `LIVE_TUTOR_TEST_USER_EMAILS` containing only the exact test account emails. Other users keep the normal production limit. Remove both values after the countdown and ledger test passes.
