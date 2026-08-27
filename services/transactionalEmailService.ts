import logger from '../lib/logger';

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function mobileLink(path: string, token: string) {
  const scheme = (process.env.MOBILE_APP_SCHEME?.trim() || 'mentomobile').replace(/:\/\/$/, '');
  return `${scheme}://${path}?token=${encodeURIComponent(token)}`;
}

async function sendEmail(input: { to: string; subject: string; html: string }) {
  const apiKey = required('RESEND_API_KEY');
  const from = required('AUTH_EMAIL_FROM');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'User-Agent': 'Mento/1.0' },
    body: JSON.stringify({ from, to: [input.to], subject: input.subject, html: input.html }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    logger.error('Transactional email provider rejected message', { status: response.status });
    throw new Error('Transactional email could not be sent.');
  }
}

function layout(title: string, body: string, link: string, action: string) {
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#111827"><h1>${title}</h1><p>${body}</p><p><a href="${link}" style="display:inline-block;padding:12px 18px;background:#2563eb;color:white;text-decoration:none;border-radius:8px">${action}</a></p><p style="font-size:13px;color:#6b7280">This link expires soon. If you did not request this, you can ignore this email.</p></div>`;
}

export async function sendVerificationEmail(email: string, token: string) {
  const link = mobileLink('verify-email', token);
  await sendEmail({ to: email, subject: 'Verify your Mento email', html: layout('Verify your email', 'Confirm this email address to finish creating your Mento account.', link, 'Verify email') });
}

export async function sendPasswordResetEmail(email: string, token: string) {
  const link = mobileLink('reset-password', token);
  await sendEmail({ to: email, subject: 'Reset your Mento password', html: layout('Reset your password', 'Use this secure link to choose a new Mento password.', link, 'Reset password') });
}

export async function sendEmailChangeConfirmation(email: string, token: string) {
  const link = mobileLink('confirm-email-change', token);
  await sendEmail({ to: email, subject: 'Confirm your new Mento email', html: layout('Confirm your new email', 'Confirm this address before Mento changes the email on your account.', link, 'Confirm new email') });
}
