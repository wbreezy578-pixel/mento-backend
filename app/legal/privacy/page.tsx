import LegalPage from '../LegalPage';

export const metadata = {
  title: 'Privacy Policy — Mento',
  description: 'Learn what information Mento processes, why it is used, and the choices available to you.',
  alternates: { canonical: '/legal/privacy' },
};

export default function PrivacyPolicyPage() {
  return <LegalPage title="Privacy Policy" updated="September 10, 2026">
    <p>Mento is an AI learning application operated in Kenya by VALD MWAGHALI MALUSHA. This policy explains what information Mento processes, why it is used, and the choices available to you.</p>
    <h2>Information we process</h2>
    <ul>
      <li>Account information such as your email address, display name, authentication provider, and security/session records.</li>
      <li>Learning content you submit, including chat messages and images you choose to upload.</li>
      <li>Live Tutor voice while a session is active, related transcript/conversation content, and technical session identifiers needed to deliver audio and avatar video.</li>
      <li>Purchase identifiers, subscription state, receipts, and an accounting ledger. Mento does not receive or store your full card number.</li>
      <li>Operational information such as request identifiers, error events, feature usage, device/app version, and abuse-prevention signals.</li>
      <li>For free accounts, advertising information processed by Google Mobile Ads/AdMob, which may include device, app, network, advertising identifier, and ad-interaction information under Google&apos;s policies and your consent choices.</li>
    </ul>
    <h2>Camera and microphone</h2>
    <p>Camera or photo access is used only when you choose an image for tutoring. Microphone access is used only for Live Tutor voice conversations. Mento does not activate either permission in the background.</p>
    <h2>Advertising</h2>
    <p>Free accounts may display clearly labelled banner advertising supplied through Google Mobile Ads (AdMob). Google may process advertising and device information to serve, measure, limit, and protect advertising, subject to its own terms, privacy policy, and any consent choices presented in the app. Where required, Mento uses Google&apos;s consent flow before requesting ads. Paid features are not a request for advertising consent.</p>
    <h2>Service providers</h2>
    <p>Mento uses Google Gemini to analyze Normal Chat prompts and images; OpenAI Realtime to process Live Tutor voice and generate realtime tutoring audio; and Simli and its realtime media infrastructure to render and stream the Live Tutor avatar. Mento also uses Supabase for sign-in; PostgreSQL for account and learning data; Redis for short-lived coordination; Microsoft Azure for backend hosting; Google Mobile Ads/AdMob for advertising; and Google Play for Android purchases. These providers may process information in countries outside Kenya under their own privacy and security commitments.</p>
    <p>Live Tutor voice is transmitted while the session is active to provide the feature. Mento does not intentionally retain raw microphone recordings after transient delivery, but conversation/transcript content and provider processing may be retained or handled as described in this policy and the relevant provider&apos;s terms. Do not submit passwords, financial account details, government identifiers, health records, or other highly sensitive personal information in chat, images, or Live Tutor.</p>
    <h2>Retention and deletion</h2>
    <p>Conversations and their messages are automatically deleted after one year without an update. You may delete individual conversations sooner. Account data remains while your account is active. You can delete your account in Mento under Settings → Delete Account. Deletion removes account content and credentials; limited payment, security, fraud-prevention, and legally required records may be retained. Google Play controls store subscription records, and Google/other providers may retain data under their own policies.</p>
    <h2>Your choices</h2>
    <p>You may access or update account details in the app, delete conversations, revoke camera or microphone permissions in device settings, restore purchases through Google Play, and request account deletion. For access, correction, deletion, objection, or another privacy request, email <a href="mailto:mentosupport@gmail.com">mentosupport@gmail.com</a>.</p>
    <h2>Children</h2>
    <p>Mento is only for people aged 18 or older. By creating an account, you confirm that you are at least 18. Accounts reasonably believed to belong to a person under 18 may be suspended and deleted.</p>
    <h2>Security and contact</h2>
    <p>Mento uses authentication, encrypted transport, access controls, rate limits, minimized operational logs, and server-side purchase verification. No service can promise absolute security. Questions can be sent to <a href="mailto:mentosupport@gmail.com">mentosupport@gmail.com</a>.</p>
  </LegalPage>;
}
