import test from 'node:test';
import assert from 'node:assert/strict';
import { isReadinessHealthy } from './healthStatus';

test('treats successful Gemini health as healthy', () => {
  const checks = {
    database: { status: 'ok' },
    redis: { status: 'ok' },
    gemini: { success: true, modelAvailable: true, message: 'Gemini is reachable.' },
    simli: { status: 'ok' },
    paymentProviders: {
      mpesa: { status: 'ok' },
      paddle: { status: 'ok' },
    },
  };

  assert.equal(isReadinessHealthy(checks), true);
});

test('marks readiness as degraded when Gemini reports a failure', () => {
  const checks = {
    database: { status: 'ok' },
    redis: { status: 'ok' },
    gemini: { success: false, modelAvailable: false, message: 'Gemini failed.' },
    simli: { status: 'ok' },
    paymentProviders: {
      mpesa: { status: 'ok' },
      paddle: { status: 'ok' },
    },
  };

  assert.equal(isReadinessHealthy(checks), false);
});

test('marks readiness as degraded when required Redis is unavailable', () => {
  const checks = {
    database: { status: 'ok' },
    redis: { status: 'fail' },
    gemini: { status: 'ok' },
    simli: { status: 'ok' },
    paymentProviders: {
      mpesa: { status: 'ok' },
      paddle: { status: 'ok' },
    },
  };

  assert.equal(isReadinessHealthy(checks), false);
});
