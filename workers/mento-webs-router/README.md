# Mento Websites router

This Worker serves immutable Mento Websites artifacts from a private R2 bucket. Production customer hostnames use exact Worker Custom Domains; the Worker is never attached to a wildcard route.

## Local and staging safety

- The default Wrangler environment has no routes or custom domains, and `workers_dev = false`.
- The `staging` environment uses a staging-only R2 bucket name and an invalid placeholder resolver URL. Its only public entry point is its isolated `workers.dev` address for staging tests.
- The `production` environment uses only `mento-websites-production` and the Green API resolver. It has no wildcard route or fixed custom domain.
- Customer hostnames use the reserved first-level prefix `web-`, for example `web-denton-waterhub.trymentoapp.com`. The backend attaches each hostname as an exact Custom Domain on this Worker when the owner publishes. This keeps `auth.trymentoapp.com` outside the Worker configuration.
- Keep the production R2 bucket private; do not enable `r2.dev` or a public bucket domain. The backend requires a bucket-scoped R2 S3 credential, while the Worker reads through its R2 binding.
- Set `WEBSITE_ROUTER_SHARED_SECRET` as a production Worker secret before attaching customer hostnames. The matching value must be available to the Green backend only through Secret Manager.

## Worker contract

For a customer hostname, the Worker requests:

`GET {WEBSITE_RESOLVER_URL}?hostname={normalized-host}`

It authenticates the request with `x-mento-timestamp`, `x-mento-nonce`, and an HMAC-SHA256 signature using `WEBSITE_ROUTER_SHARED_SECRET`. The signed value binds the method, resolver path, query hostname, timestamp, and nonce. The backend returns only the current published website ID, deployment ID, and manifest key.

The Worker reads the manifest and listed content through the `WEBSITE_DEPLOYMENTS` R2 binding. The bucket must remain private; do not enable `r2.dev` or a public bucket domain.

## Staging commands

Install this package's development dependency, then run `npm run dev:local`. Local development uses Wrangler's local R2 emulation and does not create Cloudflare resources. `npm run deploy:staging` is intentionally separate and requires an explicit Cloudflare login plus a pre-created staging R2 bucket. Do not run it until a staging backend, secret, and bucket are ready.

The staging environment must use a staging resolver URL and staging-only signing secret. Its current `.invalid` URL is a fail-closed placeholder, not a usable endpoint.

## Production release

1. Create the private `mento-websites-production` R2 bucket and a bucket-scoped S3 token.
2. Deploy the Worker with `npx wrangler deploy --env production`, then add `WEBSITE_ROUTER_SHARED_SECRET` with `npx wrangler secret put WEBSITE_ROUTER_SHARED_SECRET --env production`.
3. Store the production R2 credentials and shared router secret in Secret Manager; enable the publishing flag only on the Green backend.
4. The backend provisions exact `web-<slug>.trymentoapp.com` Worker Custom Domains through the Cloudflare Workers Domains API as each website is published. No wildcard DNS record or Worker route is required.
5. Verify a published hostname and confirm `auth.trymentoapp.com` and the production API route still resolve to their existing services.
