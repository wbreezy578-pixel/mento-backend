export default async function BillingSuccessPage({ searchParams }: { searchParams: Promise<{ paddleTransactionId?: string }> }) {
  const { paddleTransactionId = '' } = await searchParams;
  const appUrl = `mentomobile://billing/complete?paddleTransactionId=${encodeURIComponent(paddleTransactionId)}`;
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#f7f7fb', color: '#17171f' }}>
      <section style={{ maxWidth: 520, padding: 32, borderRadius: 20, background: 'white', boxShadow: '0 20px 60px rgba(0,0,0,.08)', textAlign: 'center' }}>
        <h1>Payment received</h1>
        <p style={{ margin: '16px 0 24px' }}>Mento is verifying the payment. Your plan or minutes will appear after server confirmation.</p>
        <a href={appUrl} style={{ display: 'inline-block', padding: '12px 18px', borderRadius: 12, background: '#6366f1', color: 'white', textDecoration: 'none' }}>Return to Mento</a>
      </section>
    </main>
  );
}
