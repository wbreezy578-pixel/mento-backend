import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContentSecurityPolicy, buildCorsHeaders, isAllowedOrigin } from '../../lib/securityHeaders';

test('allows configured origins and echoes them back', () => {
  const previous = process.env.ALLOWED_ORIGINS;
  process.env.ALLOWED_ORIGINS = 'https://app.example.com,https://admin.example.com';

  try {
    assert.equal(isAllowedOrigin('https://app.example.com'), true);
    assert.equal(isAllowedOrigin('https://evil.example.com'), false);

    const headers = buildCorsHeaders('https://app.example.com');
    assert.equal(headers['Access-Control-Allow-Origin'], 'https://app.example.com');
    assert.equal(headers['Vary'], 'Origin');
  } finally {
    if (previous === undefined) {
      delete process.env.ALLOWED_ORIGINS;
    } else {
      process.env.ALLOWED_ORIGINS = previous;
    }
  }
});

test('allows local LAN dev origins by default', () => {
  const headers = buildCorsHeaders('http://10.0.0.7:8082');
  assert.equal(headers['Access-Control-Allow-Origin'], 'http://10.0.0.7:8082');
});

test('omits CORS allow-origin for untrusted origins', () => {
  const headers = buildCorsHeaders('https://evil.example.com');
  assert.equal(headers['Access-Control-Allow-Origin'], undefined);
});

test('allows the Simli dev test route to use wss://api.simli.ai without affecting production', () => {
  const basePolicy = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none';";

  assert.equal(buildContentSecurityPolicy('/dev/simli-test', 'development'), basePolicy.replace("connect-src 'self' https:", "connect-src 'self' https: wss://api.simli.ai wss://*.livekit.cloud"));
  assert.equal(buildContentSecurityPolicy('/dev/simli-test', 'production'), basePolicy);
  assert.equal(buildContentSecurityPolicy('/other-route', 'development'), basePolicy);
});
