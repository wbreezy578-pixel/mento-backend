import test from 'node:test';
import assert from 'node:assert/strict';
import { isReadinessHealthy } from './healthStatus';

test('treats critical infrastructure as ready', () => {
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

test('does not restart the application when an external provider is degraded', () => {
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

  assert.equal(isReadinessHealthy(checks), true);
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
