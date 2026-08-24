import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDeletionCredential } from './accountDeletion';

test('prefers password credentials when provided', async () => {
  const result = await resolveDeletionCredential({ password: 'StrongPassword123!', googleAccessToken: '' }, { authProvider: 'email' });
  assert.deepEqual(result, { mode: 'password', value: 'StrongPassword123!' });
});

test('accepts recent Google re-authentication when no password is present', async () => {
  const result = await resolveDeletionCredential({ password: '', googleAccessToken: 'google-token' }, {
    authProvider: 'google',
    email: 'user@example.com',
    lastOAuthReauthAt: new Date(Date.now() - 5 * 60 * 1000),
  }, {
    verifyGoogleAccessToken: async () => ({ email: 'user@example.com' }),
  });
  assert.deepEqual(result, { mode: 'google', value: 'google-token' });
});

test('requires recent Google re-authentication for Google-linked accounts', async () => {
  await assert.rejects(
    () => resolveDeletionCredential({ password: '', googleAccessToken: '' }, {
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
    /Google-linked accounts require a recent Google re-authentication/i
  );
});
test('requires recent Google re-authentication for stale OAuth sessions', async () => {
  await assert.rejects(
    () => resolveDeletionCredential(
      { password: '', googleAccessToken: 'google-token' },
      {
        authProvider: 'google',
        email: 'user@example.com',
        lastOAuthReauthAt: new Date(Date.now() - 20 * 60 * 1000),
      },
      { verifyGoogleAccessToken: async () => ({ email: 'user@example.com' }) }
    ),
    /Please re-authenticate with Google recently before deleting your account\./i
  );
});
test('rejects missing credentials', async () => {
  await assert.rejects(() => resolveDeletionCredential({ password: '', googleAccessToken: '' }, { authProvider: 'email' }), /Password confirmation is required to delete your account\.|Password or Google re-authentication/i);
});
