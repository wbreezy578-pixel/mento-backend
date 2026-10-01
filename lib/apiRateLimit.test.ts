import assert from 'node:assert/strict';
import test from 'node:test';

function bucket(pathname: string, method: string, ip: string) {
  const normalizedPath = pathname.replace(/\/[A-Za-z0-9_-]{12,}(?=\/|$)/g, '/:id');
  return `${method}:${normalizedPath}:${ip}`;
}

test('API rate-limit buckets are isolated by method, path, and client IP', () => {
  assert.notEqual(bucket('/api/settings', 'GET', '203.0.113.10'), bucket('/api/settings', 'PATCH', '203.0.113.10'));
  assert.notEqual(bucket('/api/settings', 'GET', '203.0.113.10'), bucket('/api/wallet', 'GET', '203.0.113.10'));
  assert.notEqual(bucket('/api/settings', 'GET', '203.0.113.10'), bucket('/api/settings', 'GET', '203.0.113.11'));
  assert.equal(bucket('/api/conversations/abcdefghijklmnop', 'GET', '203.0.113.10'), bucket('/api/conversations/qrstuvwxyzabcdef', 'GET', '203.0.113.10'));
});
