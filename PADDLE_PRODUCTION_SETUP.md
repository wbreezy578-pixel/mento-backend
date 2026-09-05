# Paddle production setup

Mento uses Paddle Billing for web purchases. Azure owns transaction creation, webhook verification, fulfillment, ledger writes, and the customer portal. Vercel serves the public checkout page that loads Paddle.js.

## Paddle dashboard

1. Create or verify the live Pro, 50-minute, and 100-minute prices.
2. Add the Vercel checkout URL as an approved/default payment-link domain, for example `https://mento.example.com/billing/checkout`.
3. Create a live notification destination pointing to:
   `https://<azure-container-app-domain>/api/payments/webhook/paddle`
4. Subscribe it to at least:
   - `transaction.completed`
   - `transaction.payment_failed`
   - `subscription.created`
   - `subscription.activated`
   - `subscription.updated`
   - `subscription.trialing`
   - `subscription.past_due`
   - `subscription.paused`
   - `subscription.resumed`
   - `subscription.canceled`
   - `adjustment.updated`
5. Create a live API key for Azure and a live client-side token for Vercel.

## Azure Container Apps secrets and environment variables

Secrets:

- `PADDLE_API_KEY` — live server API key; never expose it to Vercel client code or mobile.
- `PADDLE_NOTIFICATION_WEBHOOK_SECRET` — endpoint secret for the exact Azure notification destination.

Configuration:

- `PADDLE_ENV=production`
- `PADDLE_PRO_PRICE_ID=pri_...`
- `PADDLE_TOP_UP_50_PRICE_ID=pri_...`
- `PADDLE_TOP_UP_100_PRICE_ID=pri_...`
- `PADDLE_CHECKOUT_URL=https://<vercel-domain>/billing/checkout`

Azure does not need `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN` when Vercel serves checkout.

## Vercel environment variables

- `PADDLE_ENV=production`
- `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN=live_...` — Paddle client-side token; safe for browser use but restrict it to the live approved domain in Paddle.

Vercel does not need the Paddle API key or webhook secret in the recommended split deployment. If the full API is intentionally served from Vercel instead of Azure, then Vercel becomes a backend and needs the complete Azure variable set too; do not run two active webhook fulfillment backends.

## Mobile release flag

Production mobile builds keep browser billing disabled unless `EXPO_PUBLIC_WEB_BILLING_ENABLED=true` is set at build time. Enable this only for distributions/storefronts where the browser purchase link is permitted. StoreKit and Google Play Billing remain separate launch work for storefronts that require native billing.

## Release order

1. Back up the production database.
2. Check that `UserWallet.paddleCustomerId` and `UserWallet.paddleSubscriptionId` contain no duplicates; the migration intentionally enforces ownership uniqueness.
3. Run `npm run migrate:deploy` once as a release job.
4. Deploy the Vercel checkout page and verify its production URL.
5. Set Azure secrets/configuration and deploy the backend image.
6. Configure the live webhook destination only after the new Azure revision is healthy.
7. Complete one low-risk live purchase, renewal simulation, cancellation, and refund verification before opening payments to all users.

Never copy sandbox values (`pdl_sdbx_...`, test client tokens, or sandbox notification secrets) into the production environment.
