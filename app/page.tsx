import type { Metadata } from 'next';
import Link from 'next/link';
import styles from './home.module.css';

export const metadata: Metadata = {
  title: 'Mento — AI learning, made conversational',
  description: 'Mento is an AI learning companion for focused chat, image understanding, and optional Live Tutor conversations.',
};

const features = [
  {
    number: '01',
    title: 'Learn through conversation',
    body: 'Ask questions, explore ideas, and work through difficult topics in a calm, focused chat experience.',
  },
  {
    number: '02',
    title: 'Understand what you see',
    body: 'Choose an image when you want Mento to explain a diagram, document, exercise, or visual question.',
  },
  {
    number: '03',
    title: 'Talk with Live Tutor',
    body: 'Pro members can start a voice conversation with an AI tutor presented through an animated avatar.',
  },
];

const trustLinks = [
  { href: '/legal/privacy', label: 'Privacy Policy', detail: 'How Mento handles account, learning, audio, and purchase data.' },
  { href: '/legal/terms', label: 'Terms of Service', detail: 'The rules and conditions that apply when using Mento.' },
  { href: '/legal/ai', label: 'AI Transparency', detail: 'How Gemini, Simli, and Mento safety controls support the experience.' },
  { href: '/legal/account-deletion', label: 'Account Deletion', detail: 'How to permanently delete a Mento account and associated content.' },
];

export default function HomePage() {
  return (
    <main className={styles.page}>
      <nav className={styles.nav} aria-label="Primary navigation">
        <Link className={styles.brand} href="/" aria-label="Mento home">
          <span className={styles.brandMark} aria-hidden="true">M</span>
          <span>Mento</span>
        </Link>
        <div className={styles.navLinks}>
          <Link href="/legal/ai">About the AI</Link>
          <a href="mailto:mentosupport@gmail.com">Support</a>
        </div>
      </nav>

      <section className={styles.hero} aria-labelledby="home-title">
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}><span aria-hidden="true" /> Your space to understand more</p>
          <h1 id="home-title">Learning feels better when it feels like a conversation.</h1>
          <p className={styles.lede}>
            Mento is an AI learning companion for thoughtful chat, image understanding,
            and real-time voice tutoring—built to help you explore ideas at your own pace.
          </p>
          <div className={styles.actions}>
            <a className={styles.primaryAction} href="mailto:mentosupport@gmail.com?subject=Mento%20Android%20access">Contact support</a>
            <Link className={styles.secondaryAction} href="/legal/ai">How Mento uses AI</Link>
          </div>
          <p className={styles.availability}>Mento for Android is currently preparing for Google Play testing.</p>
        </div>

        <aside className={styles.tutorCard} aria-label="Mento experience preview">
          <div className={styles.orbit} aria-hidden="true">
            <span className={styles.orbitCore}>M</span>
            <span className={styles.orbitRing} />
          </div>
          <div>
            <p className={styles.cardLabel}>MENTO LEARNING SPACE</p>
            <h2>Ask. Explore. Understand.</h2>
            <p>One focused place for text, visual, and voice-based learning.</p>
          </div>
          <div className={styles.statusRow}>
            <span><i aria-hidden="true" /> AI-powered</span>
            <span>18+</span>
          </div>
        </aside>
      </section>

      <section className={styles.featureSection} aria-labelledby="features-title">
        <div className={styles.sectionHeading}>
          <p className={styles.kicker}>A flexible learning companion</p>
          <h2 id="features-title">Choose the way you want to learn.</h2>
        </div>
        <div className={styles.featureGrid}>
          {features.map((feature) => (
            <article className={styles.featureCard} key={feature.number}>
              <span>{feature.number}</span>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.trustSection} aria-labelledby="trust-title">
        <div className={styles.trustCopy}>
          <p className={styles.kicker}>Clear by design</p>
          <h2 id="trust-title">Know what happens behind every conversation.</h2>
          <p>
            Mento identifies itself as AI, explains its providers, and gives you direct
            controls for conversations, permissions, and account deletion.
          </p>
          <p className={styles.caution}>Mento can make mistakes. Verify important information.</p>
        </div>
        <div className={styles.trustLinks}>
          {trustLinks.map((item) => (
            <Link href={item.href} key={item.href}>
              <span>
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </span>
              <b aria-hidden="true">↗</b>
            </Link>
          ))}
        </div>
      </section>

      <footer className={styles.footer}>
        <div>
          <span className={styles.brandMark} aria-hidden="true">M</span>
          <p><strong>Mento</strong><br />AI-assisted learning for adults.</p>
        </div>
        <div className={styles.footerLinks}>
          <Link href="/legal/privacy">Privacy</Link>
          <Link href="/legal/terms">Terms</Link>
          <Link href="/legal/account-deletion">Delete account</Link>
          <a href="mailto:mentosupport@gmail.com">mentosupport@gmail.com</a>
        </div>
        <p className={styles.copyright}>© 2026 Mento. Operated by VALD MWAGHALI MALUSHA in Kenya.</p>
      </footer>
    </main>
  );
}
