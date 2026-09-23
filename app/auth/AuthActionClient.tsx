'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';

type AuthAction = 'verify-email' | 'reset-password' | 'confirm-email-change';
type Status = 'idle' | 'submitting' | 'success' | 'error';

const ACTIONS: Record<AuthAction, {
  eyebrow: string;
  title: string;
  description: string;
  action: string;
  success: string;
  endpoint: string;
  appStatus: string;
}> = {
  'verify-email': {
    eyebrow: 'EMAIL VERIFICATION',
    title: 'Verify your Mento email',
    description: 'Confirm this address to finish creating your account.',
    action: 'Verify email',
    success: 'Your email is verified. You can now sign in to Mento.',
    endpoint: '/api/auth/verify-email',
    appStatus: 'email-verified',
  },
  'reset-password': {
    eyebrow: 'PASSWORD RECOVERY',
    title: 'Choose a new password',
    description: 'Use at least 15 characters. Your other Mento sessions will be signed out.',
    action: 'Reset password',
    success: 'Your password has been reset. You can now sign in to Mento.',
    endpoint: '/api/auth/reset-password',
    appStatus: 'password-reset',
  },
  'confirm-email-change': {
    eyebrow: 'EMAIL CHANGE',
    title: 'Confirm your new email',
    description: 'Confirm this address to complete the change. Your other Mento sessions will be signed out.',
    action: 'Confirm new email',
    success: 'Your email has been changed. Sign in again with the new address.',
    endpoint: '/api/auth/confirm-email-change',
    appStatus: 'email-changed',
  },
};

function readError(body: unknown) {
  if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
    return body.error;
  }
  return 'Mento could not complete this request. Please request a new email and try again.';
}

export default function AuthActionClient({ action, token, mobileScheme }: {
  action: AuthAction;
  token: string;
  mobileScheme: string;
}) {
  const copy = ACTIONS[action];
  const [status, setStatus] = useState<Status>(token ? 'idle' : 'error');
  const [message, setMessage] = useState(token ? '' : 'This link is incomplete. Request a new email from Mento.');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const appLink = useMemo(
    () => `${mobileScheme.replace(/:\/\/$/, '')}://auth/login?status=${encodeURIComponent(copy.appStatus)}`,
    [copy.appStatus, mobileScheme],
  );

  useEffect(() => {
    if (token && window.location.search) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, [token]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || status === 'submitting') return;

    if (action === 'reset-password' && password !== confirmPassword) {
      setStatus('error');
      setMessage('Passwords must match.');
      return;
    }

    setStatus('submitting');
    setMessage('');
    try {
      const payload = action === 'reset-password'
        ? { token, password, confirmPassword }
        : { token };
      const response = await fetch(copy.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(readError(body));
      setStatus('success');
      setMessage(copy.success);
      setPassword('');
      setConfirmPassword('');
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : readError(null));
    }
  }

  return (
    <main style={styles.page}>
      <section style={styles.card} aria-labelledby="auth-action-title">
        <div style={styles.mark} aria-hidden="true">M</div>
        <p style={styles.eyebrow}>{copy.eyebrow}</p>
        <h1 id="auth-action-title" style={styles.title}>{status === 'success' ? 'All set' : copy.title}</h1>
        <p style={styles.description}>{status === 'success' ? copy.success : copy.description}</p>

        {status !== 'success' ? (
          <form onSubmit={submit} style={styles.form}>
            {action === 'reset-password' ? (
              <>
                <label style={styles.label}>
                  New password
                  <span style={styles.passwordField}>
                    <input
                      type={showPassword ? 'text' : 'password'}
                      minLength={15}
                      maxLength={72}
                      autoComplete="new-password"
                      required
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      style={styles.input}
                    />
                    <button
                      type="button"
                      aria-label={showPassword ? 'Hide new password' : 'Show new password'}
                      aria-pressed={showPassword}
                      onClick={() => setShowPassword((visible) => !visible)}
                      style={styles.visibilityButton}
                    >
                      <EyeIcon hidden={showPassword} />
                    </button>
                  </span>
                </label>
                <label style={styles.label}>
                  Confirm new password
                  <span style={styles.passwordField}>
                    <input
                      type={showConfirmPassword ? 'text' : 'password'}
                      minLength={15}
                      maxLength={72}
                      autoComplete="new-password"
                      required
                      value={confirmPassword}
                      onChange={(event) => setConfirmPassword(event.target.value)}
                      style={styles.input}
                    />
                    <button
                      type="button"
                      aria-label={showConfirmPassword ? 'Hide confirmation password' : 'Show confirmation password'}
                      aria-pressed={showConfirmPassword}
                      onClick={() => setShowConfirmPassword((visible) => !visible)}
                      style={styles.visibilityButton}
                    >
                      <EyeIcon hidden={showConfirmPassword} />
                    </button>
                  </span>
                </label>
              </>
            ) : null}
            <button type="submit" disabled={!token || status === 'submitting'} style={styles.primaryButton}>
              {status === 'submitting' ? 'Please wait…' : copy.action}
            </button>
          </form>
        ) : (
          <a href={appLink} style={styles.primaryLink}>Open Mento</a>
        )}

        {message && status !== 'success' ? (
          <p role="alert" style={styles.error}>{message}</p>
        ) : null}
        <p style={styles.footnote}>Mento will never ask you to send this private link to another person.</p>
      </section>
    </main>
  );
}

function EyeIcon({ hidden }: { hidden: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.7" />
      {hidden ? <path d="m4 4 16 16" /> : null}
    </svg>
  );
}

const styles: Record<string, CSSProperties> = {
  page: {
    minHeight: '100vh',
    display: 'grid',
    placeItems: 'center',
    padding: '24px',
    boxSizing: 'border-box',
    background: '#0b0f17',
    color: '#f4f7fb',
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  card: {
    width: '100%',
    maxWidth: '460px',
    padding: '34px',
    boxSizing: 'border-box',
    border: '1px solid #253044',
    borderRadius: '22px',
    background: '#121926',
    boxShadow: '0 24px 80px rgba(0, 0, 0, 0.35)',
  },
  mark: {
    width: '42px',
    height: '42px',
    display: 'grid',
    placeItems: 'center',
    marginBottom: '24px',
    borderRadius: '13px',
    background: '#36d4e7',
    color: '#071015',
    fontWeight: 800,
    fontSize: '20px',
  },
  eyebrow: { margin: '0 0 10px', color: '#6de4ef', fontSize: '12px', fontWeight: 700, letterSpacing: '0.12em' },
  title: { margin: 0, fontSize: '30px', lineHeight: 1.18, letterSpacing: '-0.03em' },
  description: { margin: '14px 0 26px', color: '#aeb9ca', fontSize: '16px', lineHeight: 1.6 },
  form: { display: 'grid', gap: '16px' },
  label: { display: 'grid', gap: '8px', color: '#dce4ef', fontSize: '14px', fontWeight: 600 },
  passwordField: { position: 'relative', display: 'block' },
  input: { width: '100%', boxSizing: 'border-box', padding: '13px 48px 13px 14px', border: '1px solid #334159', borderRadius: '12px', outline: 'none', background: '#0d1420', color: '#f7f9fc', fontSize: '16px' },
  visibilityButton: { position: 'absolute', top: '50%', right: '8px', width: '36px', height: '36px', display: 'grid', placeItems: 'center', transform: 'translateY(-50%)', padding: 0, border: 0, borderRadius: '9px', background: 'transparent', color: '#aeb9ca', cursor: 'pointer' },
  primaryButton: { width: '100%', padding: '14px 18px', border: 0, borderRadius: '12px', background: '#36d4e7', color: '#071015', cursor: 'pointer', fontSize: '16px', fontWeight: 750 },
  primaryLink: { display: 'block', padding: '14px 18px', borderRadius: '12px', background: '#36d4e7', color: '#071015', textAlign: 'center', textDecoration: 'none', fontSize: '16px', fontWeight: 750 },
  error: { margin: '18px 0 0', padding: '12px 14px', border: '1px solid #6d3340', borderRadius: '10px', background: '#27151c', color: '#ffb8c3', fontSize: '14px', lineHeight: 1.45 },
  footnote: { margin: '24px 0 0', color: '#77849a', fontSize: '12px', lineHeight: 1.55 },
};
