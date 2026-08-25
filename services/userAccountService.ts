import { Prisma } from '@prisma/client';
import { normalizeEmail, hashPassword } from '../app/lib/auth';
import { prisma } from '../lib/prisma';

export type SupportedAuthProvider = 'email' | 'google' | 'apple' | 'admin' | 'test-helper';

export interface CreateUserAccountInput {
  email: string;
  password?: string;
  name?: string | null;
  authProvider?: SupportedAuthProvider;
  emailVerified?: boolean;
}

export interface CreateUserAccountResult {
  user: {
    id: string;
    email: string;
    password: string;
    name: string | null;
    authProvider: string;
    emailVerified: boolean;
  };
  created: boolean;
  requiresPasswordSetup?: boolean;
  existingUserId?: string | null;
}

export class DuplicateEmailError extends Error {
  constructor(email: string) {
    super('Email already exists');
    this.name = 'DuplicateEmailError';
    this.message = `Email already exists: ${email}`;
  }
}

export class InvalidAccountInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAccountInputError';
  }
}

function sanitizeDisplayName(name: string | null | undefined) {
  const value = typeof name === 'string' ? name.trim() : '';
  return value.length > 0 ? value : null;
}

async function ensureFreePlan(tx: Prisma.TransactionClient) {
  return tx.plan.upsert({
    where: { name: 'FREE' },
    update: {},
    create: { name: 'FREE', price: 0 },
  });
}

async function createDefaultWalletsAndPreferences(tx: Prisma.TransactionClient, userId: string, freePlanId: string) {
  await tx.userWallet.create({
    data: {
      user: { connect: { id: userId } },
      plan: { connect: { id: freePlanId } },
      subscriptionStatus: 'active',
    },
  });

  await tx.liveTutorWallet.create({
    data: {
      user: { connect: { id: userId } },
      minutesBalance: 0,
    },
  });

  await tx.notificationPreference.create({
    data: {
      user: { connect: { id: userId } },
      emailEnabled: true,
      pushEnabled: true,
      marketingEnabled: false,
      weeklyDigestEnabled: true,
    },
  });

  await tx.userSetting.create({
    data: {
      user: { connect: { id: userId } },
      theme: 'system',
      language: 'en',
      timezone: 'UTC',
      compactMode: false,
    },
  });
}

function buildAccountResult(user: { id: string; email: string; password: string; name: string | null; authProvider: string; emailVerified: boolean }, created: boolean, extra?: Partial<CreateUserAccountResult>): CreateUserAccountResult {
  return {
    user: {
      id: user.id,
      email: user.email,
      password: user.password,
      name: user.name,
      authProvider: user.authProvider,
      emailVerified: user.emailVerified,
    },
    created,
    ...extra,
  };
}

async function createNewUserAccount(tx: Prisma.TransactionClient, input: CreateUserAccountInput): Promise<CreateUserAccountResult> {
  const normalizedEmail = normalizeEmail(input.email);
  if (!normalizedEmail) {
    throw new InvalidAccountInputError('Email is required');
  }

  const existingUser = await tx.user.findFirst({
    where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
  });

  if (existingUser) {
    const updateData: { name?: string | null; emailVerified?: boolean; lastOAuthReauthAt?: Date } = {};
    const userName = sanitizeDisplayName(input.name);
    if (!existingUser.name && userName) {
      updateData.name = userName;
    }

    const authProvider = input.authProvider ?? 'email';
    const shouldVerifyEmail = input.emailVerified ?? (authProvider === 'google' || authProvider === 'apple' || authProvider === 'admin');
    if (shouldVerifyEmail && !existingUser.emailVerified) {
      updateData.emailVerified = true;
    }

    if ((authProvider === 'google' || authProvider === 'apple' || authProvider === 'admin') && !existingUser.lastOAuthReauthAt) {
      updateData.lastOAuthReauthAt = new Date();
    }

    let updatedUser = existingUser;
    if (Object.keys(updateData).length > 0) {
      updatedUser = await tx.user.update({
        where: { id: existingUser.id },
        data: updateData,
      });
    }

    return buildAccountResult(updatedUser, false, {
      requiresPasswordSetup: authProvider === 'email' && !(typeof updatedUser.password === 'string' && updatedUser.password.trim().length > 0),
      existingUserId: updatedUser.id,
    });
  }

  const authProvider = input.authProvider ?? 'email';
  const password = typeof input.password === 'string' ? input.password : undefined;

  if (authProvider === 'email' && (!password || !password.trim())) {
    throw new InvalidAccountInputError('Password is required for email signup');
  }

  const hashedPassword = password && password.trim().length > 0 ? await hashPassword(password) : '';
  const shouldUsePassword = authProvider !== 'google' && authProvider !== 'apple' && Boolean(password && password.trim().length > 0);
  const resolvedPassword = shouldUsePassword ? hashedPassword : '';
  const userName = sanitizeDisplayName(input.name);
  const emailVerified = input.emailVerified ?? (authProvider === 'google' || authProvider === 'apple' || authProvider === 'admin');

  // If creating an OAuth-backed account, mark a recent OAuth reauthentication
  // so that sensitive actions requiring recent OAuth reauth are allowed immediately after signup.
  const lastOAuthReauthAt = authProvider === 'google' || authProvider === 'apple' || authProvider === 'admin' ? new Date() : undefined;

  try {
    const user = await tx.user.create({
      data: {
        email: normalizedEmail,
        password: resolvedPassword,
        name: userName,
        authProvider,
        lastOAuthReauthAt,
        emailVerified,
      },
    });

    const freePlan = await ensureFreePlan(tx);
    await createDefaultWalletsAndPreferences(tx, user.id, freePlan.id);

    return buildAccountResult(user, true);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const recoveredUser = await tx.user.findFirst({
        where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
      });
      if (recoveredUser) {
        return buildAccountResult(recoveredUser, false, {
          requiresPasswordSetup: authProvider === 'email' && !(typeof recoveredUser.password === 'string' && recoveredUser.password.trim().length > 0),
          existingUserId: recoveredUser.id,
        });
      }
    }
    throw error;
  }
}

export async function createEmailAccount(input: CreateUserAccountInput): Promise<CreateUserAccountResult> {
  return prisma.$transaction(
    async (tx) => createNewUserAccount(tx, { ...input, authProvider: 'email' }),
    { maxWait: 10000, timeout: 30000 }
  );
}

export async function createGoogleOAuthAccount(input: CreateUserAccountInput): Promise<CreateUserAccountResult> {
  return prisma.$transaction(
    async (tx) => {
      const normalizedEmail = normalizeEmail(input.email);
      if (!normalizedEmail) {
        throw new InvalidAccountInputError('Email is required');
      }

      const existingUser = await tx.user.findFirst({
        where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
      });

      if (existingUser) {
        const updateData: { name?: string | null; lastOAuthReauthAt?: Date; emailVerified?: boolean; authProvider?: string } = {};
        const displayName = sanitizeDisplayName(input.name);
        if (!existingUser.name && displayName) {
          updateData.name = displayName;
        }
        updateData.lastOAuthReauthAt = new Date();
        updateData.emailVerified = true;
        updateData.authProvider = existingUser.password?.trim() ? 'mixed' : 'google';
        const updatedUser = await tx.user.update({
          where: { id: existingUser.id },
          data: updateData,
        });
        return buildAccountResult(updatedUser, false, {
          existingUserId: updatedUser.id,
        });
      }

      return createNewUserAccount(tx, { ...input, authProvider: 'google', emailVerified: true, password: '' });
    },
    { maxWait: 10000, timeout: 15000 }
  );
}

export async function createAppleAccount(input: CreateUserAccountInput): Promise<CreateUserAccountResult> {
  return prisma.$transaction(
    async (tx) => {
      const normalizedEmail = normalizeEmail(input.email);
      if (!normalizedEmail) throw new InvalidAccountInputError('Email is required');
      const existingUser = await tx.user.findFirst({ where: { email: { equals: normalizedEmail, mode: 'insensitive' } } });
      if (existingUser) {
        const displayName = sanitizeDisplayName(input.name);
        const updatedUser = await tx.user.update({
          where: { id: existingUser.id },
          data: {
            name: existingUser.name || displayName,
            lastOAuthReauthAt: new Date(),
            emailVerified: true,
            authProvider: existingUser.password?.trim() ? 'mixed' : 'apple',
          },
        });
        return buildAccountResult(updatedUser, false, { existingUserId: updatedUser.id });
      }
      return createNewUserAccount(tx, { ...input, authProvider: 'apple', emailVerified: true, password: '' });
    },
    { maxWait: 10000, timeout: 30000 }
  );
}

export async function createAdminUserAccount(input: CreateUserAccountInput): Promise<CreateUserAccountResult> {
  return prisma.$transaction(
    async (tx) => createNewUserAccount(tx, { ...input, authProvider: 'admin', emailVerified: true }),
    { maxWait: 10000, timeout: 30000 }
  );
}

export async function createTestUserAccount(input: CreateUserAccountInput): Promise<CreateUserAccountResult> {
  return prisma.$transaction(
    async (tx) => createNewUserAccount(tx, { ...input, authProvider: 'test-helper', emailVerified: true }),
    { maxWait: 10000, timeout: 30000 }
  );
}
