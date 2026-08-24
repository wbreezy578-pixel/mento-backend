import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { getEffectivePlanForUser, getPlanById, getPlanByName } from './planService';

export interface WalletSummary {
  userId: string;
  planName: string;
  subscriptionStatus: string;
  liveTutorMinutesBalance: number;
  imageLimit: number | null;
  messageLimit: number | null;
  fairUseEnabled: boolean;
  liveTutorEnabled: boolean;
  priority: number;
}

export interface UserWalletState {
  id: string;
  userId: string;
  planId: string;
  planName: string;
  subscriptionStatus: string;
}

export interface LiveTutorWalletState {
  id: string;
  userId: string;
  minutesBalance: number;
}

export class WalletServiceError extends Error {
  code: string;
  details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'WalletServiceError';
    this.code = code;
    this.details = details;
  }
}

function normalizePlanName(name: string | null | undefined): string | null {
  if (typeof name !== 'string') {
    return null;
  }

  const normalized = name.trim().toUpperCase();
  if (normalized === 'FREE' || normalized === 'PRO') {
    return normalized;
  }

  return null;
}

function ensureValidPlanName(userId: string, planName: string | null | undefined, action: 'upgrade' | 'downgrade'): string {
  const normalizedName = normalizePlanName(planName);
  if (!normalizedName) {
    throw new WalletServiceError('INVALID_PLAN', 'The requested plan is not supported.', { userId, requestedPlan: planName, action });
  }

  return normalizedName;
}

function toWalletSummary(userId: string, planName: string, subscriptionStatus: string, liveTutorWallet: LiveTutorWalletState | null): WalletSummary {
  return {
    userId,
    planName,
    subscriptionStatus,
    liveTutorMinutesBalance: liveTutorWallet?.minutesBalance ?? 0,
    imageLimit: null,
    messageLimit: null,
    fairUseEnabled: false,
    liveTutorEnabled: false,
    priority: 0,
  };
}

export async function getWallet(userId: string): Promise<UserWalletState | null> {
  const wallet = await prisma.userWallet.findUnique({
    where: { userId },
    include: { plan: true },
  });

  if (!wallet) {
    return null;
  }

  return {
    id: wallet.id,
    userId: wallet.userId,
    planId: wallet.planId,
    planName: wallet.plan.name,
    subscriptionStatus: wallet.subscriptionStatus,
  };
}

export async function getLiveTutorWallet(userId: string): Promise<LiveTutorWalletState | null> {
  const wallet = await prisma.liveTutorWallet.findUnique({ where: { userId } });
  if (!wallet) {
    return null;
  }

  return {
    id: wallet.id,
    userId: wallet.userId,
    minutesBalance: wallet.minutesBalance,
  };
}

export async function ensureWallet(userId: string): Promise<UserWalletState> {
  const plan = await getPlanByName('FREE');
  if (!plan) {
    throw new WalletServiceError('PLAN_NOT_FOUND', 'The FREE plan is required to initialize a wallet.', { userId });
  }

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const existing = await tx.userWallet.findUnique({ where: { userId } });
    if (existing) {
      return {
        id: existing.id,
        userId: existing.userId,
        planId: existing.planId,
        planName: plan.name,
        subscriptionStatus: existing.subscriptionStatus,
      };
    }

    const created = await tx.userWallet.create({
      data: {
        user: { connect: { id: userId } },
        plan: { connect: { id: plan.id } },
        subscriptionStatus: 'active',
      },
    });

    return {
      id: created.id,
      userId: created.userId,
      planId: created.planId,
      planName: plan.name,
      subscriptionStatus: created.subscriptionStatus,
    };
  });
}

export async function ensureLiveTutorWallet(userId: string): Promise<LiveTutorWalletState> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const existing = await tx.liveTutorWallet.findUnique({ where: { userId } });
    if (existing) {
      return {
        id: existing.id,
        userId: existing.userId,
        minutesBalance: existing.minutesBalance,
      };
    }

    const created = await tx.liveTutorWallet.create({
      data: {
        user: { connect: { id: userId } },
        minutesBalance: 0,
      },
    });

    return {
      id: created.id,
      userId: created.userId,
      minutesBalance: created.minutesBalance,
    };
  });
}

export async function addMinutes(userId: string, amount: number): Promise<LiveTutorWalletState> {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new WalletServiceError('INVALID_AMOUNT', 'Minutes to add must be a positive number.', { userId, amount });
  }

  await ensureLiveTutorWallet(userId);

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const wallet = await tx.liveTutorWallet.update({
      where: { userId },
      data: { minutesBalance: { increment: amount } },
    });

    return {
      id: wallet.id,
      userId: wallet.userId,
      minutesBalance: wallet.minutesBalance,
    };
  });
}

export async function consumeMinutes(userId: string, amount: number): Promise<LiveTutorWalletState | null> {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new WalletServiceError('INVALID_AMOUNT', 'Minutes to consume must be a positive number.', { userId, amount });
  }

  await ensureLiveTutorWallet(userId);

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const current = await tx.liveTutorWallet.findUnique({ where: { userId } });
    if (!current || current.minutesBalance < amount) {
      return null;
    }

    const updated = await tx.liveTutorWallet.update({
      where: { userId },
      data: { minutesBalance: { decrement: amount } },
    });

    return {
      id: updated.id,
      userId: updated.userId,
      minutesBalance: updated.minutesBalance,
    };
  });
}

export async function upgradePlan(userId: string, planName: string): Promise<UserWalletState> {
  const normalizedName = ensureValidPlanName(userId, planName, 'upgrade');
  const plan = await getPlanByName(normalizedName);
  if (!plan) {
    throw new WalletServiceError('PLAN_NOT_FOUND', 'The requested plan could not be found.', { userId, planName: normalizedName });
  }

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const existing = await tx.userWallet.findUnique({ where: { userId } });
    if (!existing) {
      const created = await tx.userWallet.create({
        data: {
          user: { connect: { id: userId } },
          plan: { connect: { id: plan.id } },
          subscriptionStatus: 'active',
        },
      });
      return {
        id: created.id,
        userId: created.userId,
        planId: created.planId,
        planName: plan.name,
        subscriptionStatus: created.subscriptionStatus,
      };
    }

    const updated = await tx.userWallet.update({
      where: { userId },
      data: {
        plan: { connect: { id: plan.id } },
        subscriptionStatus: 'active',
      },
    });

    return {
      id: updated.id,
      userId: updated.userId,
      planId: updated.planId,
      planName: plan.name,
      subscriptionStatus: updated.subscriptionStatus,
    };
  });
}

export async function downgradePlan(userId: string, planName: string): Promise<UserWalletState> {
  const normalizedName = ensureValidPlanName(userId, planName, 'downgrade');
  const plan = await getPlanByName(normalizedName);
  if (!plan) {
    throw new WalletServiceError('PLAN_NOT_FOUND', 'The requested plan could not be found.', { userId, planName: normalizedName });
  }

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const existing = await tx.userWallet.findUnique({ where: { userId } });
    if (!existing) {
      const created = await tx.userWallet.create({
        data: {
          user: { connect: { id: userId } },
          plan: { connect: { id: plan.id } },
          subscriptionStatus: 'active',
        },
      });
      return {
        id: created.id,
        userId: created.userId,
        planId: created.planId,
        planName: plan.name,
        subscriptionStatus: created.subscriptionStatus,
      };
    }

    const updated = await tx.userWallet.update({
      where: { userId },
      data: {
        plan: { connect: { id: plan.id } },
        subscriptionStatus: 'active',
      },
    });

    return {
      id: updated.id,
      userId: updated.userId,
      planId: updated.planId,
      planName: plan.name,
      subscriptionStatus: updated.subscriptionStatus,
    };
  });
}

export async function getWalletSummary(userId: string): Promise<WalletSummary> {
  const wallet = await getWallet(userId);
  const liveTutorWallet = await getLiveTutorWallet(userId);
  const plan = await getEffectivePlanForUser(userId);

  return {
    userId,
    planName: plan.name,
    subscriptionStatus: plan.name !== 'FREE' ? 'active' : 'inactive',
    liveTutorMinutesBalance: liveTutorWallet?.minutesBalance ?? 0,
    imageLimit: plan.imageLimit ?? plan.imageDailyLimit ?? null,
    messageLimit: plan.messageLimit ?? null,
    fairUseEnabled: plan.fairUseEnabled ?? false,
    liveTutorEnabled: plan.liveTutorEnabled,
    priority: plan.priority ?? 0,
  };
}

export async function addLiveTutorMinutes(userId: string, amount: number): Promise<WalletSummary> {
  await addMinutes(userId, amount);
  const summary = await getWalletSummary(userId);
  // best-effort notification: minutes added
  try {
    const { createNotification } = await import('../app/services/notificationService');
    await createNotification(userId, {
      title: 'Live Tutor minutes added',
      body: `Your Live Tutor balance increased by ${amount} minute${amount === 1 ? '' : 's'}.`,
      type: 'wallet',
    });
  } catch (e) {
    // ignore
  }
  return summary;
}

export async function consumeLiveTutorMinutes(userId: string, amount: number): Promise<boolean> {
  const wallet = await consumeMinutes(userId, amount);
  return wallet !== null;
}
