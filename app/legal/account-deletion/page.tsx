import LegalPage from '../LegalPage';

export const metadata = { title: 'Delete Your Mento Account' };

export default function AccountDeletionPage() {
  return <LegalPage title="Delete your Mento account" updated="August 25, 2026">
    <h2>Delete from the app</h2>
    <ol>
      <li>Open Mento and sign in.</li>
      <li>Open Settings and choose Delete Account.</li>
      <li>Complete the security confirmation and type “delete my account”.</li>
    </ol>
    <p>The request is processed immediately. Account credentials, sessions, conversations, settings, and learning data are deleted. Completed payment and fraud-prevention records may be retained in anonymized form where legally required.</p>
    <h2>If you cannot access the app</h2>
    <p>Email <a href="mailto:mentosupport@gmail.com?subject=Mento%20account%20deletion%20request">mentosupport@gmail.com</a> from the address on your Mento account. We will verify account ownership before deletion.</p>
    <h2>Subscriptions</h2>
    <p>Google Play subscriptions associated with Mento are cancelled during account deletion when technically available. Confirm their status in Google Play after deletion.</p>
  </LegalPage>;
}
