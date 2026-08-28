import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  updateUser: vi.fn(),
  revokeSessions: vi.fn(),
}));

vi.mock('../lib/prisma', () => ({
  prisma: {
    $transaction: vi.fn(async (operation: (transaction: unknown) => unknown) => operation({
      user: {
        findUnique: mocks.findUnique,
        findFirst: mocks.findFirst,
        update: mocks.updateUser,
      },
      session: { updateMany: mocks.revokeSessions },
    })),
  },
}));

import { createGoogleOAuthAccount, InvalidAccountInputError } from './userAccountService';

const existingUser = {
  id: 'user-1',
  email: 'learner@example.com',
  password: '$2b$12$existing-password-hash',
  name: 'Learner',
  authProvider: 'email',
  oauthProvider: null,
  emailVerified: false,
  accountStatus: 'UNVERIFIED',
  supabaseUserId: null,
  credentialsChangedAt: new Date('2026-08-01T00:00:00.000Z'),
};

describe('OAuth account linking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue(null);
    mocks.findFirst.mockResolvedValue(existingUser);
    mocks.revokeSessions.mockResolvedValue({ count: 1 });
    mocks.updateUser.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...existingUser, ...data }));
  });

  it('safely transfers an unverified password placeholder to a verified provider identity', async () => {
    const result = await createGoogleOAuthAccount({
      email: 'LEARNER@example.com',
      name: 'Learner',
      externalUserId: 'google-user-1',
    });

    expect(result.created).toBe(false);
    expect(result.user.password).toBe('');
    expect(result.user.authProvider).toBe('google');
    expect(mocks.revokeSessions).toHaveBeenCalledWith({ where: { userId: existingUser.id, revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    expect(mocks.updateUser).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        emailVerified: true,
        supabaseUserId: 'google-user-1',
        credentialsChangedAt: expect.any(Date),
      }),
    }));
  });

  it('refuses to replace an account already bound to another provider identity', async () => {
    mocks.findFirst.mockResolvedValue({ ...existingUser, supabaseUserId: 'google-user-existing' });
    await expect(createGoogleOAuthAccount({
      email: existingUser.email,
      externalUserId: 'google-user-attacker',
    })).rejects.toBeInstanceOf(InvalidAccountInputError);
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it('keeps a verified password when adding a verified provider as mixed authentication', async () => {
    const verified = { ...existingUser, emailVerified: true, accountStatus: 'ACTIVE' };
    mocks.findFirst.mockResolvedValue(verified);
    mocks.updateUser.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...verified, ...data }));

    const result = await createGoogleOAuthAccount({
      email: verified.email,
      externalUserId: 'google-user-verified',
    });
    expect(result.user.password).toBe(verified.password);
    expect(result.user.authProvider).toBe('mixed');
    expect(mocks.revokeSessions).not.toHaveBeenCalled();
  });
});
