import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from '../lib/prisma';
import { createPasswordResetToken, consumePasswordResetToken } from '../lib/authSession';
import { createEmailAccount } from '../services/userAccountService';

test('password reset token is single-use and tied to the authenticated user', async () => {
  const email = `reset-flow-${Date.now()}@example.com`;

  try {
    const account = await createEmailAccount({
      email,
      password: 'ResetPassword123!',
      name: 'Reset Flow User',
    });

    const token = await createPasswordResetToken(account.user.id);
    const firstUse = await consumePasswordResetToken(token);
    assert.ok(firstUse);
    assert.equal(firstUse?.userId, account.user.id);

    const secondUse = await consumePasswordResetToken(token);
    assert.equal(secondUse, null);
  } finally {
    await prisma.user.deleteMany({ where: { email } });
  }
});
