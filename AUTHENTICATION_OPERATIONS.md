# Mento Authentication Operations Guide

## Browser authentication gate

Mento is mobile-first. Keep `AUTH_BROWSER_SIGN_IN_ENABLED=false` unless a
reviewed browser sign-in surface is intentionally being launched.

Enabling it requires an exact HTTPS `ALLOWED_ORIGINS` allowlist, verification
of the delivered nonce-based CSP, and confirmation that browser login,
refresh, and OAuth responses contain no bearer tokens. Browser cookies are
host-only, `HttpOnly`, `Secure` in production, `SameSite=Lax`, and `Path=/`.
Do not use a client-controlled flag to select browser-session behavior.

`SameSite=Lax` is intentional: it supplies cross-site request protection
without breaking ordinary OAuth navigation. It is not a substitute for CSP,
output encoding, authorization, or origin checks.

## Session lifetime policy

The current policy is a 30-day refresh-session idle lifetime and a 90-day
absolute lifetime. This is a product/UX decision, not a token-theft
mitigation: refresh tokens are single-use, hashed at rest, and reuse revokes
their family. Do not silently lengthen it. Any proposed change must be
reviewed with mobile-session UX, incident response, and the absolute lifetime
together; it remains server controlled.

## JWT signing-key rotation plan

The current runtime has one active JWT signing secret. For a suspected secret
exposure, revoke affected sessions, rotate the secret in the deployment secret
store, deploy, and require affected clients to sign in again. Never place a
signing secret in source control, mobile configuration, logs, or responses.

For a planned rotation, first ship a reviewed dual-key verifier that signs
with a new key identifier and verifies the old key only during a short,
explicitly configured overlap. Store both keys in the deployment secret
manager, switch the signer, observe failures for at least the maximum access
token lifetime plus clock skew, then remove the old verifier key. Refresh
sessions remain separately server-revocable. Do not configure a next key until
the runtime supports that staged verifier.

## Production release checks

Before enabling browser auth or changing session policy, verify the running
revision: browser auth is disabled unless approved, `ALLOWED_ORIGINS` contains
only intended HTTPS origins, login/refresh/logout/OAuth/CSP/CORS tests pass,
and response headers confirm the delivered CSP and cookie attributes.
