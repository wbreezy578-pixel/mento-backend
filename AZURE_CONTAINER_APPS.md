# Azure Container Apps foundation

This phase deploys the existing custom Node server to Azure Container Apps with external HTTPS ingress on port 3000. The custom WebSocket gateway is attached by `server.ts` and uses the same process as the Next.js application.

## Build

Build the image from the workspace root. The Next.js development Simli test page imports the checked-in mobile Simli bundle during the build:

```text
docker build -f mento/Dockerfile -t YOUR_REGISTRY/mento:TAG .
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

## Current scope

- Persistent Node process
- HTTPS ingress with WebSocket-compatible transport
- Log Analytics application logs
- Parameterized secrets
- Exactly one replica for the voice server. Gemini Live connections are process-local and cannot be safely load-balanced between replicas.

Redis-backed lease coordination is supported, but it does not make the live Gemini connection portable between processes. Multi-replica voice hosting requires a dedicated realtime worker/session service and is not enabled by this deployment.
