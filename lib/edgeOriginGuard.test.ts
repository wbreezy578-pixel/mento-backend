import assert from 'node:assert/strict';
import test from 'node:test';
import { isEdgeOriginRequestAllowed } from './edgeOriginGuard';

test('allows all traffic while edge origin protection is not configured', () => {
  assert.equal(isEdgeOriginRequestAllowed('/api/chat', new Headers(), ''), true);
});

test('allows health probes without the edge token', () => {
  assert.equal(isEdgeOriginRequestAllowed('/api/live', new Headers(), 'edge-secret'), true);
  assert.equal(isEdgeOriginRequestAllowed('/api/ready', new Headers(), 'edge-secret'), true);
});

test('rejects direct traffic when the edge token is missing or wrong', () => {
  assert.equal(isEdgeOriginRequestAllowed('/api/chat', new Headers(), 'edge-secret'), false);
  assert.equal(isEdgeOriginRequestAllowed('/api/chat', new Headers({ 'x-mento-edge-token': 'wrong' }), 'edge-secret'), false);
});

test('allows traffic carrying the configured edge token', () => {
  assert.equal(isEdgeOriginRequestAllowed('/api/chat', new Headers({ 'x-mento-edge-token': 'edge-secret' }), 'edge-secret'), true);
});
