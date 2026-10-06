# Blue Google Play billing test setup

Blue billing is isolated from Green in three places: Blue uses its own Play app package and product IDs, the Blue backend verifies only those IDs, and the Blue Cloud Run service uses the isolated `mento-blue-db` database. The Green package, Play products, service identity, and billing database remain unchanged.

## Blue test products

Create these products in the Play Console app whose package name is `com.trymentoapp.mento.blue`:

| Product type | Product ID | Configuration |
| --- | --- | --- |
| Subscription | `mento_blue_pro_monthly` | Monthly base plan |
| One-time product | `mento_blue_live_tutor_50` | 50-minute top-up |
| One-time product | `mento_blue_live_tutor_100` | 100-minute top-up |
| Subscription | `mento_blue_hosting_slot` | Base plans `sites-1`, `sites-3`, and `sites-5` |

Keep this app in an internal testing track. Add only designated license-test accounts to the tester list. Install the app from its Play testing link when checking Billing; a sideloaded APK is not a substitute for a Play test-track installation.

## Publisher API access

Enable the Google Play Android Publisher API and add the Blue Cloud Run runtime service account as a Play Console user with the minimum permissions needed to view financial/order data and manage orders/subscriptions for the Blue app only. Do not grant it access to the Green app. Blue uses Cloud Run Application Default Credentials, not a downloaded service-account key.

Configure a separate Google Play Real-time Developer Notifications topic for the Blue app. Its authenticated push subscription must call:

`https://blue-api.trymentoapp.com/api/payments/mobile/google-rtdn`

Set the Blue service's `GOOGLE_PLAY_RTDN_AUDIENCE` and `GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL` to that push subscription's OIDC audience and service account. Do not reuse Green's topic, subscription, or audience.

## Blue backend runtime

The Blue service must use these settings before enabling payment verification:

```text
GOOGLE_PLAY_BILLING_MODE=blue-test
GOOGLE_PLAY_PACKAGE_NAME=com.trymentoapp.mento.blue
DATABASE_URL=Secret Manager: mento-blue-database-url
DIRECT_URL=Secret Manager: mento-blue-database-url
```

The service deliberately rejects Google Play verification if it is running as Blue without `blue-test` mode, if the package name differs, or if the client sends a Green product ID. The isolated database must have all current Prisma migrations applied before the Blue service is switched to it.

## Build and test

Build an Android App Bundle for the Play testing track with:

```powershell
npx eas-cli build --platform android --profile blue-play-testing
```

Upload the resulting bundle only to the Blue app's internal testing track. Test with a designated license tester, confirm product lookup and test purchase, verify the Blue account receives the entitlement, and confirm no corresponding wallet, payment, or entitlement record appears in the Green production database.
