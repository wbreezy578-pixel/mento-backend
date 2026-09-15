import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadEnvironmentFromDotEnv } from './env.ts';

test('loadEnvironmentFromDotEnv merges values from .env when .env.local exists', () => {
  const originalCwd = process.cwd();
  const originalEnv: Record<string, string | undefined> = {};
  const keys = ['DATABASE_URL', 'DIRECT_URL', 'JWT_SECRET', 'GEMINI_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'PAYMENT_WEBHOOK_AUTH_SECRET', 'AUTH_WEB_BASE_URL'];

  for (const key of keys) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mento-env-'));

  try {
    fs.writeFileSync(path.join(tempDir, '.env.local'), [
      'DATABASE_URL=postgresql://local-user:local-pass@localhost:5432/localdb',
      'JWT_SECRET=local-secret',
    ].join('\n'));

    fs.writeFileSync(path.join(tempDir, '.env'), [
      'DIRECT_URL=postgresql://direct-user:direct-pass@localhost:5432/directdb',
      'GEMINI_API_KEY=gemini-key',
      'SUPABASE_URL=https://example.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=service-role-key',
      'SUPABASE_ANON_KEY=anon-key',
      'PAYMENT_WEBHOOK_AUTH_SECRET=webhook-secret',
      'AUTH_WEB_BASE_URL=https://auth.example.com',
    ].join('\n'));

    process.chdir(tempDir);
    loadEnvironmentFromDotEnv();

    assert.equal(process.env.DATABASE_URL, 'postgresql://local-user:local-pass@localhost:5432/localdb');
    assert.equal(process.env.DIRECT_URL, 'postgresql://direct-user:direct-pass@localhost:5432/directdb');
    assert.equal(process.env.JWT_SECRET, 'local-secret');
    assert.equal(process.env.GEMINI_API_KEY, 'gemini-key');
    assert.equal(process.env.AUTH_WEB_BASE_URL, 'https://auth.example.com');
  } finally {
    process.chdir(originalCwd);
    for (const key of keys) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
