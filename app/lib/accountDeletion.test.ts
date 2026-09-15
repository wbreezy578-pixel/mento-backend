import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDeletionCredential } from './accountDeletion';

test('prefers password credentials when provided', async () => {
  const result = await resolveDeletionCredential({ password: 'StrongPassword123!' }, { authProvider: 'email' });
  assert.deepEqual(result, { mode: 'password', value: 'StrongPassword123!' });
});

test('accepts a freshly reissued Mento session after Google re-authentication', async () => {
  const result = await resolveDeletionCredential({ password: '' }, {
    authProvider: 'google',
    email: 'user@example.com',
    lastOAuthReauthAt: new Date(Date.now() - 5 * 60 * 1000),
  });
  assert.deepEqual(result, { mode: 'google', value: '' });
});

test('uses the persisted Apple provider for mixed accounts', async () => {
  const result = await resolveDeletionCredential({ password: '' }, {
    authProvider: 'mixed',
    oauthProvider: 'apple',
    lastOAuthReauthAt: new Date(Date.now() - 5 * 60 * 1000),
  });
  assert.deepEqual(result, { mode: 'apple', value: '' });
});

test('requires recent Google re-authentication for Google-linked accounts', async () => {
  await assert.rejects(
    () => resolveDeletionCredential({ password: '' }, {
      authProvider: 'google',
      email: 'user@example.com',
      lastOAuthReauthAt: new Date(Date.now() - 20 * 60 * 1000),
    }),
    /Please re-authenticate with Google recently before deleting your account\./i
  );
});

test('rejects password credentials for Google-linked accounts', async () => {
  await assert.rejects(
    () => resolveDeletionCredential({ password: 'StrongPassword123!' }, { authProvider: 'google' }),
    /OAuth-linked accounts require a recent provider re-authentication/i
  );
});
test('rejects missing credentials', async () => {
  await assert.rejects(() => resolveDeletionCredential({ password: '' }, { authProvider: 'email' }), /Password confirmation is required to delete your account\./i);
});
