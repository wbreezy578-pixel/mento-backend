import test from 'node:test';
import assert from 'node:assert/strict';

// Ensure auth modules can sign tokens during tests
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-please-change';

import { prisma } from '../lib/prisma';
import { createGoogleOAuthAccount, createEmailAccount } from '../services/userAccountService';
import { signToken, verifyPassword } from '../app/lib/auth';
import * as passwordRoute from '../app/api/me/password/route';
import * as resetRoute from '../app/api/auth/reset-password/route';
import { createSessionRecord, generateSecureToken, findSessionByToken, createPasswordResetToken } from '../lib/authSession';
import { sanitizeForLogging } from '../lib/sanitize';

test('Google-only user can set their first password (no current password required)', async () => {
  const email = `gset-${Date.now()}@example.com`;
  try {
    const created = await createGoogleOAuthAccount({ email, name: 'G User' });
    assert.equal(created.user.password, '');

    const token = signToken(created.user.id, created.user.email, { expiresInSeconds: 60 });
    const req = new Request('https://example.com/api/me/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ newPassword: 'NewStrongPass123!', confirmPassword: 'NewStrongPass123!' }),
    });

    const resp = await passwordRoute.POST(req);
    const body = await resp.json().catch(() => ({}));
    assert.equal(body.success, true);
    assert.equal(body.passwordSetup, true);

    const updated = await prisma.user.findUnique({ where: { id: created.user.id } });
    assert.ok(updated?.password && updated.password.trim().length > 0);
    // setting a password on a google-only account should mark it as mixed
    assert.equal(updated?.authProvider, 'mixed');
  } finally {
    await prisma.user.deleteMany({ where: { email } });
  }
});

test('Existing password user follows normal change-password flow and sessions revoked', async () => {
  const email = `change-${Date.now()}@example.com`;
  try {
    const created = await createEmailAccount({ email, password: 'OldPass123!', name: 'Old User' });
    const token = signToken(created.user.id, created.user.email, { expiresInSeconds: 60 });

    // create a session token that should be revoked after password change
    const sessionToken = generateSecureToken(24);
    await createSessionRecord({ userId: created.user.id, token: sessionToken, expiresAt: new Date(Date.now() + 60_000 * 10) });
    const found = await findSessionByToken(sessionToken);
    assert.ok(found && found.revokedAt === null);

    const req = new Request('https://example.com/api/me/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ currentPassword: 'OldPass123!', newPassword: 'BrandNewPass123!', confirmPassword: 'BrandNewPass123!' }),
    });

    const resp = await passwordRoute.POST(req);
    const body = await resp.json().catch(() => ({}));
    assert.equal(body.success, true);
    assert.equal(body.passwordSetup, false);

    const stillActive = await findSessionByToken(sessionToken);
    assert.equal(stillActive, null);

    const updated = await prisma.user.findUnique({ where: { id: created.user.id } });
    assert.ok(updated && updated.password && updated.password.trim().length > 0);
    // verify the new password works
    assert.equal(await verifyPassword('BrandNewPass123!', updated!.password), true);
  } finally {
    await prisma.user.deleteMany({ where: { email } });
  }
});

test('Password reset tokens are single-use', async () => {
  const email = `reset-${Date.now()}@example.com`;
  try {
    const created = await createEmailAccount({ email, password: 'InitialPass123!', name: 'Reset User' });

    const plain = await createPasswordResetToken(created.user.id, 5);

    // first use should succeed
    const req1 = new Request('https://example.com/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: plain, password: 'ResetNewPass123!', confirmPassword: 'ResetNewPass123!' }),
    });
    const r1 = await resetRoute.POST(req1);
    const b1 = await r1.json().catch(() => ({}));
    assert.equal(b1.ok, true);

    // second use should fail
    const req2 = new Request('https://example.com/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: plain, password: 'AnotherPass123!', confirmPassword: 'AnotherPass123!' }),
    });
    const r2 = await resetRoute.POST(req2);
    const b2 = await r2.json().catch(() => ({}));
    assert.ok(b2.error, 'Expected error on reused token');

    const updated = await prisma.user.findUnique({ where: { id: created.user.id } });
    assert.ok(updated && updated.password && updated.password.trim().length > 0);
    assert.equal(await verifyPassword('ResetNewPass123!', updated!.password), true);
  } finally {
    await prisma.user.deleteMany({ where: { email } });
  }
});

test('Client cannot select another user account when changing password', async () => {
  const emailA = `a-${Date.now()}@example.com`;
  const emailB = `b-${Date.now()}@example.com`;
  try {
    const a = await createEmailAccount({ email: emailA, password: 'APass123!', name: 'A' });
    const b = await createEmailAccount({ email: emailB, password: 'BPass123!', name: 'B' });

    const token = signToken(a.user.id, a.user.email, { expiresInSeconds: 60 });
    const req = new Request('https://example.com/api/me/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      // attacker-supplied userId: should be ignored by server
      body: JSON.stringify({ userId: b.user.id, currentPassword: 'APass123!', newPassword: 'ANewStrongPass123!', confirmPassword: 'ANewStrongPass123!' }),
    });

    const resp = await passwordRoute.POST(req);
    const body = await resp.json().catch(() => ({}));
    assert.equal(body.success, true);

    const updatedA = await prisma.user.findUnique({ where: { id: a.user.id } });
    const updatedB = await prisma.user.findUnique({ where: { id: b.user.id } });
    assert.ok(updatedA && await verifyPassword('ANewStrongPass123!', updatedA.password));
    assert.ok(updatedB && await verifyPassword('BPass123!', updatedB.password));
  } finally {
    await prisma.user.deleteMany({ where: { email: { in: [emailA, emailB] } } });
  }
});

test('sanitizeForLogging redacts password values', () => {
  const payload = { username: 'user', password: 'super-secret' };
  const sanitized = sanitizeForLogging(payload) as unknown as Record<string, unknown>;
  assert.equal(sanitized.password, '[REDACTED]');
});
