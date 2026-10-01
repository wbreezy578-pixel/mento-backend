import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveTutorProviderHttpStatus } from './liveTutorProviderError';

test('provider credential failures never request learner reauthentication', () => {
  assert.equal(liveTutorProviderHttpStatus(401), 503);
  assert.equal(liveTutorProviderHttpStatus(403), 503);
});

test('preserves provider throttling and upstream failure statuses', () => {
  assert.equal(liveTutorProviderHttpStatus(429), 429);
  assert.equal(liveTutorProviderHttpStatus(502), 502);
  assert.equal(liveTutorProviderHttpStatus(undefined), 503);
});
