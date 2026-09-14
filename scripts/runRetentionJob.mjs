import { createHmac, randomBytes } from 'node:crypto';

const endpoint = process.env.MENTO_RETENTION_URL?.trim();
const secret = process.env.RETENTION_JOB_SECRET?.trim();

if (!endpoint || !secret) {
  throw new Error('MENTO_RETENTION_URL and RETENTION_JOB_SECRET are required.');
}

const url = new URL(endpoint);
if (url.protocol !== 'https:' || url.pathname !== '/api/internal/retention') {
  throw new Error('MENTO_RETENTION_URL must be the HTTPS /api/internal/retention endpoint.');
}

const timestamp = Math.floor(Date.now() / 1_000).toString();
const nonce = randomBytes(24).toString('base64url');
const signature = createHmac('sha256', secret)
  .update([timestamp, nonce, 'POST', url.pathname].join('\n'))
  .digest('hex');

const response = await fetch(url, {
  method: 'POST',
  headers: {
    'x-mento-timestamp': timestamp,
    'x-mento-nonce': nonce,
    'x-mento-signature': signature,
  },
});
const body = await response.text();

// The endpoint response contains operational counts only; never print secrets.
console.log(JSON.stringify({
  event: 'mento_retention_job_completed',
  status: response.status,
  response: body.slice(0, 2_000),
}));

if (!response.ok) process.exitCode = 1;
