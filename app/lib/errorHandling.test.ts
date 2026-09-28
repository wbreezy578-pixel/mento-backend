import test from 'node:test';
import assert from 'node:assert/strict';

import { getUserFacingErrorMessage } from './errorHandling';

test('safe error helper keeps actionable validation messages', () => {
  assert.equal(
    getUserFacingErrorMessage(new Error('Passwords must match.')),
    'Passwords must match.',
  );
});

test('safe error helper hides raw technical errors from end users', () => {
  assert.equal(
    getUserFacingErrorMessage(new Error('TypeError: Cannot read properties of undefined')),
    'Something went wrong. Please refresh the page and try again.',
  );
});
