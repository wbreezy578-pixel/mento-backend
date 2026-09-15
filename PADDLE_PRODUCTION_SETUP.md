# Legacy Paddle setup reference

This document is kept only as historical context. It is not part of the current Mento production billing model.

The active Android release path uses Google Play native billing. The active Apple path uses App Store native billing. Paddle values are not used in the current build, deployment, or alpha testing flow.

## Current billing model

- Android: Google Play subscriptions and top-ups via native billing
- iOS: App Store subscriptions and top-ups via native billing
- Backend verification: `/api/payments/mobile/verify` and platform-specific server validation
- Azure secrets: Google Play and Apple credentials injected as secure Container App secrets

## Historical Paddle notes

The old Paddle flow described in earlier build notes is intentionally retired and should be ignored for all current releases.

Do not set the following for the current alpha build:

- `PADDLE_API_KEY`
- `PADDLE_NOTIFICATION_WEBHOOK_SECRET`
- `PADDLE_PRO_PRICE_ID`
- `PADDLE_TOP_UP_50_PRICE_ID`
- `PADDLE_TOP_UP_100_PRICE_ID`
- `PADDLE_CHECKOUT_URL`
- `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN`
- `PADDLE_ENV`

If a repo file still references these values, treat that reference as legacy and remove or update it before release.
