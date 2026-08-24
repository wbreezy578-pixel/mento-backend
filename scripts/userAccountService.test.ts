import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from '../lib/prisma';
import { createEmailAccount, createGoogleOAuthAccount } from '../services/userAccountService';

test('createEmailAccount provisions wallets, subscription and default preferences', async () => {
  const email = `email-service-${Date.now()}@example.com`;

  try {
    const result = await createEmailAccount({
      email,
      password: 'TestPassword123!',
      name: 'Email Service User',
    });

    assert.equal(result.user.email, email);
    assert.ok(result.user.password.length > 0);

    const wallet = await prisma.userWallet.findUnique({ where: { userId: result.user.id } });
    const tutorWallet = await prisma.liveTutorWallet.findUnique({ where: { userId: result.user.id } });
    const prefs = await prisma.notificationPreference.findUnique({ where: { userId: result.user.id } });
    const settings = await prisma.userSetting.findUnique({ where: { userId: result.user.id } });

    assert.ok(wallet);
    assert.ok(tutorWallet);
    assert.ok(prefs);
    assert.ok(settings);
    assert.equal(wallet?.subscriptionStatus, 'active');
    assert.equal(prefs?.emailEnabled, true);
    assert.equal(settings?.theme, 'system');
  } finally {
    await prisma.user.deleteMany({ where: { email } });
  }
});

test('createGoogleOAuthAccount creates a user without a usable password', async () => {
  const email = `google-service-${Date.now()}@example.com`;

  try {
    const result = await createGoogleOAuthAccount({
      email,
      name: 'Google Service User',
    });

    assert.equal(result.user.email, email);
    assert.equal(result.user.authProvider, 'google');
    assert.equal(result.user.password, '');
  } finally {
    await prisma.user.deleteMany({ where: { email } });
  }
});

test('createEmailAccount reuses an existing Google account for the same normalized email', async () => {
  const originalEmail = `link-service-${Date.now()}@Example.com`;
  const normalizedEmail = originalEmail.toLowerCase();

  const googleAccount = await createGoogleOAuthAccount({
    email: originalEmail,
    name: 'Linked Google User',
  });

  try {
    const result = await createEmailAccount({
      email: originalEmail.toUpperCase(),
      password: 'AnotherPassword123!',
      name: 'Linked Email User',
    });

    assert.equal(result.created, false);
    assert.equal(result.user.id, googleAccount.user.id);
    assert.equal(result.user.email, normalizedEmail);
    assert.equal(result.requiresPasswordSetup, true);
  } finally {
    await prisma.user.deleteMany({ where: { email: normalizedEmail } });
  }
});

test('createEmailAccount reuses an existing email/password account for the same email', async () => {
  const email = `duplicate-service-${Date.now()}@example.com`;

  const first = await createEmailAccount({ email, password: 'TestPassword123!', name: 'Duplicate User' });

  try {
    const second = await createEmailAccount({ email, password: 'AnotherPassword123!', name: 'Duplicate User 2' });

    assert.equal(second.created, false);
    assert.equal(second.user.id, first.user.id);
    assert.equal(second.user.email, email);
  } finally {
    await prisma.user.deleteMany({ where: { email } });
  }
});

test('createGoogleOAuthAccount upgrades an existing password account to linked auth', async () => {
  const email = `google-link-service-${Date.now()}@example.com`;

  const passwordAccount = await createEmailAccount({ email, password: 'LinkedPassword123!', name: 'Linked Password User' });

  try {
    const result = await createGoogleOAuthAccount({ email, name: 'Linked Google User' });

    assert.equal(result.created, false);
    assert.equal(result.user.id, passwordAccount.user.id);
    assert.equal(result.user.email, email);
  } finally {
    await prisma.user.deleteMany({ where: { email } });
  }
});
