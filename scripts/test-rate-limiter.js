#!/usr/bin/env node
// Test the live /api/chat rate limiter with an authenticated request.

import { default as fetch } from 'node-fetch';

const API = process.env.API_BASE_URL || 'http://localhost:3000';
const ENDPOINT = `${API}/api/chat`;
const TOKEN = process.env.DEMO_TOKEN || '';

const TEST_CALLS = parseInt(process.env.TEST_CALLS || '10', 10);
const DELAY_MS = parseInt(process.env.TEST_DELAY_MS || '300', 10);

if (!TOKEN) {
  console.error('❌ DEMO_TOKEN is not set.');
  console.error('');
  console.error('Set a valid authenticated token before running this test.');
  console.error('PowerShell example:');
  console.error('$env:DEMO_TOKEN="YOUR_VALID_TOKEN"');
  console.error('');
  process.exit(2);
}

async function callOnce() {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      message: 'ping',
    }),
  });

  const text = await res.text();

  return {
    status: res.status,
    body: text,
  };
}

function classifyStatus(status) {
  if (status >= 200 && status < 300) {
    return 'allowed';
  }

  if (status === 429) {
    return 'rate_limited';
  }

  if (status === 401) {
    return 'unauthorized';
  }

  if (status === 403) {
    return 'forbidden';
  }

  if (status >= 400 && status < 500) {
    return 'client_error';
  }

  if (status >= 500) {
    return 'server_error';
  }

  return 'other';
}

async function main() {
  console.log('Running rate limiter test against', ENDPOINT);
  console.log(`Requests: ${TEST_CALLS}`);
  console.log(`Delay: ${DELAY_MS}ms`);
  console.log('');

  let allowed = 0;
  let denied = 0;
  let unauthorized = 0;
  let forbidden = 0;
  let clientErrors = 0;
  let serverErrors = 0;
  let other = 0;

  // Part 1: rapid calls
  for (let i = 0; i < TEST_CALLS; i++) {
    try {
      const r = await callOnce();
      const classification = classifyStatus(r.status);

      console.log(
        `${i + 1}`,
        r.status,
        classification,
        r.body.slice(0, 200)
      );

      switch (classification) {
        case 'allowed':
          allowed++;
          break;

        case 'rate_limited':
          denied++;
          break;

        case 'unauthorized':
          unauthorized++;
          break;

        case 'forbidden':
          forbidden++;
          break;

        case 'client_error':
          clientErrors++;
          break;

        case 'server_error':
          serverErrors++;
          break;

        default:
          other++;
      }
    } catch (e) {
      console.error('Request failed:', e.message || e);
      other++;
    }

    if (i < TEST_CALLS - 1) {
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }
  }

  console.log('');
  console.log('=== Results ===');
  console.log(`Allowed:        ${allowed}`);
  console.log(`Rate limited:   ${denied}`);
  console.log(`Unauthorized:   ${unauthorized}`);
  console.log(`Forbidden:      ${forbidden}`);
  console.log(`Client errors:  ${clientErrors}`);
  console.log(`Server errors:  ${serverErrors}`);
  console.log(`Other errors:   ${other}`);
  console.log('');

  if (unauthorized > 0) {
    console.error('❌ Rate limiter test could not authenticate.');
    console.error('Check DEMO_TOKEN before evaluating limiter behavior.');
    process.exit(1);
  }

  if (denied === 0) {
    console.error('❌ No 429 responses were observed.');
    console.error('The configured rate limit may be higher than the test volume.');
    process.exit(1);
  }

  console.log('✅ Rate limiter denied at least one request.');
  console.log('Rate limiter behavior is being enforced.');
  process.exit(0);
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(2);
});
