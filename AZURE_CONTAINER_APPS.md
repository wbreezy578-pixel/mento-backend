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

Android launch requires these Azure values in addition to the core database, Redis, Gemini, Supabase, and Simli settings:

- `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`: the complete JSON for the Play Console-linked service account; store as a Container App secret.
- `GOOGLE_PLAY_RTDN_AUDIENCE`: the exact public RTDN endpoint URL, ending in `/api/payments/mobile/google-rtdn`.
- `GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL`: the service identity configured on the Pub/Sub push subscription.

The Play products must use the exact IDs `mento_pro_monthly`, `mento_live_tutor_50`, and `mento_live_tutor_100`.

Before an iOS launch, also set `APPLE_ROOT_CERTIFICATES_BASE64` and the numeric `APPLE_APP_ID`, then configure App Store Server Notifications to `/api/payments/mobile/apple-notifications`.

Paddle is only the web checkout path. Its server API key, webhook secret, three price IDs, environment, and Vercel checkout URL remain Azure settings; the public Paddle client token belongs only on Vercel.

## Current scope

- Persistent Node process
- HTTPS ingress with WebSocket-compatible transport
- Log Analytics application logs
- Parameterized secrets
- Exactly one replica for the voice server. Gemini Live connections are process-local and cannot be safely load-balanced between replicas.

Redis-backed lease coordination is supported, but it does not make the live Gemini connection portable between processes. Multi-replica voice hosting requires a dedicated realtime worker/session service and is not enabled by this deployment.
