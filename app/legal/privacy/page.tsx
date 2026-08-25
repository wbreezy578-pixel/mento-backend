import LegalPage from '../LegalPage';

export const metadata = { title: 'Privacy Policy — Mento' };

export default function PrivacyPolicyPage() {
  return <LegalPage title="Privacy Policy" updated="August 25, 2026">
    <p>Mento is an AI learning application operated in Kenya by VALD MWAGHALI MALUSHA. This policy explains what information Mento processes, why it is used, and the choices available to you.</p>
    <h2>Information we process</h2>
    <ul>
      <li>Account information such as your email address, display name, authentication provider, and security/session records.</li>
      <li>Learning content you submit, including chat messages and images you choose to upload.</li>
      <li>Live Tutor audio while a session is active and the technical session identifiers needed to deliver audio and avatar video.</li>
      <li>Purchase identifiers, subscription state, receipts, and an accounting ledger. Mento does not receive or store your full card number.</li>
      <li>Operational information such as request identifiers, error events, feature usage, device/app version, and abuse-prevention signals.</li>
    </ul>
    <h2>Camera and microphone</h2>
    <p>Camera or photo access is used only when you choose an image for tutoring. Microphone access is used only for Live Tutor voice conversations. Mento does not activate either permission in the background.</p>
    <h2>Service providers</h2>
    <p>Mento uses Google Gemini to analyze prompts and images and generate AI responses or voice output; Simli to render the Live Tutor avatar from generated audio; Supabase for sign-in; PostgreSQL for account and learning data; Redis for short-lived coordination; Microsoft Azure for backend hosting; and Google Play for Android purchases. These providers may process information in countries outside Kenya under their own privacy and security commitments.</p>
    <p>Do not submit passwords, financial account details, government identifiers, health records, or other sensitive personal information in chat, images, or Live Tutor. Mento does not use unpaid Gemini API processing for production user content.</p>
    <h2>Retention and deletion</h2>
    <p>Conversations and their messages are automatically deleted after one year without an update. You may delete individual conversations sooner. Account data remains while your account is active. You can delete your account in Mento under Settings → Delete Account. Deletion removes account content and credentials; limited payment, security, and fraud-prevention records may be retained where reasonably necessary or legally required. Google Play controls store subscription records.</p>
    <h2>Your choices</h2>
    <p>You may access or update account details in the app, delete conversations, revoke camera or microphone permissions in device settings, restore purchases through Google Play, and request account deletion. For access, correction, deletion, objection, or another privacy request, email <a href="mailto:mentosupport@gmail.com">mentosupport@gmail.com</a>.</p>
    <h2>Children</h2>
    <p>Mento is only for people aged 18 or older. By creating an account, you confirm that you are at least 18. Accounts reasonably believed to belong to a person under 18 may be suspended and deleted.</p>
    <h2>Security and contact</h2>
    <p>Mento uses authentication, encrypted transport, access controls, rate limits, minimized operational logs, and server-side purchase verification. No service can promise absolute security. Questions can be sent to <a href="mailto:mentosupport@gmail.com">mentosupport@gmail.com</a>.</p>
  </LegalPage>;
}
