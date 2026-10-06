# Mento API Router

This Worker owns two exact Cloudflare Custom Domains:

- `api.trymentoapp.com` proxies to Green by default. A later approved cutover changes `PRODUCTION_API_COLOR` to `blue`.
- `/api/websites` and its subpaths, plus Google Play purchase verification and RTDN, are routed to the tagged Green Websites candidate. Other production API paths stay on the stable Green revision.
- `blue-api.trymentoapp.com` is reserved for internal Blue candidate testing and always proxies to Blue.

Both origins are pinned to HTTPS Cloud Run hostnames. The Worker returns 404 for every other hostname, including `auth.trymentoapp.com`; it does not use a wildcard route. API responses are fetched with Cloudflare caching disabled.

Cloudflare provisions DNS and HTTPS for the two exact Custom Domains when this Worker is deployed. No DNS record or Worker route for `*.trymentoapp.com` should be added.

The mobile Blue build must use `https://blue-api.trymentoapp.com`; production builds use `https://api.trymentoapp.com`. Existing installed builds keep their compiled URLs until updated.

## Validate and deploy

Run `npm test` for routing tests. Deploy only after verifying the origins and Cloudflare account:

```powershell
npx wrangler whoami
npx wrangler deploy
```

The production hostname stays on Green until `PRODUCTION_API_COLOR` is explicitly changed and deployed after approval.
