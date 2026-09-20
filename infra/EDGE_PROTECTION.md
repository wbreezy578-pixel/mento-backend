# Backend Edge Protection

The Container App is currently externally reachable. Application authentication and
rate limiting still protect API actions, but they do not stop traffic from reaching
the origin. Production should put Azure Front Door Premium in front of the app.

## Required architecture

1. Create an Azure Front Door Premium profile and endpoint.
2. Add a WAF policy in Prevention mode with the Microsoft Default Rule Set and bot
   protection enabled where available for the subscription.
3. Add the Container App FQDN as the HTTPS origin.
4. Configure a Front Door rule to add `x-mento-edge-token` with a newly generated
   random value. Do not put this value in the mobile app or public frontend.
5. Set the same value as the secure `edgeOriginSecret` Bicep parameter. The backend
   will reject non-health requests that do not carry the matching header.
6. Point the production API hostname used by mobile at Front Door, then verify chat,
   auth, payments, and Live Tutor through that hostname.
7. After verification, restrict or disable direct Container App ingress where the
   selected Azure Container Apps networking model supports private origin access.

## Rollout safety

`EDGE_ORIGIN_SECRET` is optional for backward compatibility. Do not set it on the
Container App until Front Door is already injecting the header and the mobile API
base URL has been changed to the Front Door hostname. Health probes at `/api/live`
and `/api/ready` remain available without the header.

## Validation

```text
Direct origin /api/chat without the header: 403
Front Door /api/chat with the injected header: reaches normal auth and rate limits
Direct origin /api/live and /api/ready: available for Container Apps probes
``` 

The edge secret is wired through `infra/main.bicep` as the secure
`edgeOriginSecret` parameter and is exposed to the container only as
`EDGE_ORIGIN_SECRET`.
