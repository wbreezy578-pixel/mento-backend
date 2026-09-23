# Google Play Privacy Release Checklist

This checklist accompanies Mento's public Privacy Policy, Terms of Service,
AI and Provider Information, and account-deletion page. It is a release gate,
not a substitute for the current Google Play policies or provider disclosures.

## Public links and in-app access

- Publish an active, public, non-geofenced HTTPS URL for `/legal/privacy` in
  the Play Console Privacy policy field. Do not use a PDF.
- Keep Privacy Policy, Terms, AI and Provider Information, and account deletion
  available in Settings and during the pre-use legal notice.
- Verify the public legal pages after each deployment. Their content must match
  the installed release and the Play Data safety form.
- The developer identity in the store listing must match the policy's stated
  operator, or Mento must clearly identify the app it operates.

## Current source-based data inventory

Complete the Data safety form from the deployed build and provider documents,
not from assumptions. The current source requires review of at least:

| Data category | Product use | Recipients/processors to disclose where applicable |
| --- | --- | --- |
| Email, display name, authentication/session data | account creation, sign-in, security | Mento, Supabase, hosting/database providers |
| Chat messages and selected images | Normal Chat tutoring | Mento, Google Gemini |
| Live Tutor voice and conversation/transcript content | realtime tutoring | Mento, OpenAI Realtime, Simli/realtime avatar infrastructure |
| Purchase/subscription identifiers and receipt state | verify and grant products | Mento, Google Play |
| Device/app/version, request, and abuse-prevention signals | reliability and security | Mento service providers |
| Advertising/device identifiers and ad interactions for eligible free accounts | serve, measure, and protect ads | Google Mobile Ads/AdMob |

Do not claim that a category is not collected or shared until the actual
production SDK configuration and provider's current Data safety guidance have
been checked. In particular, verify the Android Advertising ID behavior of the
AdMob SDK and the data handling terms/configuration of OpenAI and Simli.

## Audience, ads, and consent

- Mento's code and legal notice are 18+. Configure the Play Console target
  audience consistently. Do not select child age groups or market the release
  to children while using this advertising configuration.
- If the target audience ever includes children or users of unknown age, stop
  this release process and complete the Families policy review: a neutral age
  screen, Families-compliant SDK configuration, and non-personalized ads may
  be required.
- Confirm the Google Mobile Ads consent flow is invoked before ads are
  requested where required, and test consent declined, consent granted, and
  no-network behavior.
- Keep ads clearly labelled and outside tappable navigation/content controls.

## AI and Live Tutor

- Store listing, onboarding, and the AI notice must say that Mento is an AI
  tutor and that responses can be incorrect.
- Keep an accessible in-app reporting path for unsafe or inappropriate text,
  voice, and avatar output; test it in the release build.
- Request microphone/camera/photo access only when the user initiates the
  corresponding Live Tutor or image feature. The purpose shown in the OS
  permission prompt must match the policy.

## Account deletion and subscriptions

- Keep `/legal/account-deletion` public and ensure the in-app deletion path
  works for an authenticated user.
- Account deletion must remove account data as described, subject only to
  narrow payment/security/legal retention disclosed in the policy.
- Do not claim that account deletion cancels a Google Play subscription.
  Direct users to Google Play subscription management for cancellation.

## Final owner verification

- Compare the completed Data safety answers with the exact release APK/AAB,
  backend deployment, all included SDKs, and the public policy line by line.
- Check Play Console Policy status and Pre-launch report after upload.
- Record the policy version, build number, reviewer, and verification date in
  the release record.
