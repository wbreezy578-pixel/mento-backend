import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mocks = vi.hoisted(() => ({
  conversationFindUnique: vi.fn(),
  conversationFindMany: vi.fn(),
  conversationFindFirst: vi.fn(),
  liveTutorSessionUpdateMany: vi.fn(),
  paymentFindMany: vi.fn(),
  paymentFindFirst: vi.fn(),
  ledgerFindMany: vi.fn(),
  ledgerAggregate: vi.fn(),
  usageFindMany: vi.fn(),
}));

vi.mock('./prisma', () => ({
  prisma: {
    conversation: {
      findUnique: mocks.conversationFindUnique,
      findMany: mocks.conversationFindMany,
      findFirst: mocks.conversationFindFirst,
    },
    liveTutorSession: { updateMany: mocks.liveTutorSessionUpdateMany },
    paymentTransaction: {
      findMany: mocks.paymentFindMany,
      findFirst: mocks.paymentFindFirst,
    },
    paymentLedgerEntry: {
      findMany: mocks.ledgerFindMany,
      aggregate: mocks.ledgerAggregate,
    },
    usageLog: { findMany: mocks.usageFindMany },
  },
}));

vi.mock('../services/planService', () => ({
  ensureDefaultPlans: vi.fn(),
  getEffectivePlanForUser: vi.fn(),
  getEffectiveLimit: vi.fn(),
  getPlan: vi.fn(),
  getPlanById: vi.fn(),
  getPlanByName: vi.fn(),
}));
vi.mock('./env', () => ({
  getPaddleNotificationWebhookSecret: vi.fn(() => ''),
  getPaddleTopUp50PriceId: vi.fn(() => ''),
  getPaddleTopUp100PriceId: vi.fn(() => ''),
}));
vi.mock('./paddle', () => ({ getPaddleInstance: vi.fn() }));
vi.mock('./monitoring', () => ({
  incrementMonitoringFailure: vi.fn(),
  observeMonitoringLatency: vi.fn(),
  setMonitoringProvider: vi.fn(),
}));
vi.mock('./crashRecovery', () => ({ trackShutdownOperation: vi.fn() }));
vi.mock('./logger', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { getUserConversations, validateConversationOwnership } from './conversationDb';
import { attachLiveTutorConversation, getOwnedLiveTutorConversation, listLiveTutorConversations } from '../services/liveTutorConversationService';
import { getLedgerSummary, getPayment, listPayments } from '../services/paymentService';
import { getWalletHistory } from '../services/economicsService';

function source(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

describe('IDOR ownership boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.conversationFindUnique.mockResolvedValue(null);
    mocks.conversationFindMany.mockResolvedValue([]);
    mocks.conversationFindFirst.mockResolvedValue(null);
    mocks.liveTutorSessionUpdateMany.mockResolvedValue({ count: 0 });
    mocks.paymentFindMany.mockResolvedValue([]);
    mocks.paymentFindFirst.mockResolvedValue(null);
    mocks.ledgerFindMany.mockResolvedValue([]);
    mocks.ledgerAggregate.mockResolvedValue({ _sum: { amountMinor: null } });
    mocks.usageFindMany.mockResolvedValue([]);
  });

  it('does not authorize a conversation owned by another user', async () => {
    mocks.conversationFindUnique.mockResolvedValue({ userId: 'user-b' });
    await expect(validateConversationOwnership('conversation-b', 'user-a')).resolves.toBe(false);
    expect(mocks.conversationFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'conversation-b' } }));
  });

  it('scopes conversation lists to the authenticated user and source', async () => {
    await getUserConversations('user-a', 'live_tutor');
    expect(mocks.conversationFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-a', source: 'live_tutor' } }));
  });

  it('scopes Live Tutor reads and session attachment to user ownership', async () => {
    await getOwnedLiveTutorConversation('conversation-b', 'user-a');
    expect(mocks.conversationFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'conversation-b', userId: 'user-a', source: 'live_tutor' } }));

    await attachLiveTutorConversation('stream-b', 'user-a', 'conversation-b');
    expect(mocks.liveTutorSessionUpdateMany).toHaveBeenCalledWith({
      where: { streamId: 'stream-b', userId: 'user-a' },
      data: { conversationId: 'conversation-b' },
    });

    await listLiveTutorConversations('user-a');
    expect(mocks.conversationFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-a', source: 'live_tutor' } }));
  });

  it('scopes payment and ledger reads to the authenticated user', async () => {
    await expect(getPayment('user-a', 'payment-b')).resolves.toBeNull();
    expect(mocks.paymentFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'payment-b', userId: 'user-a' } }));

    await listPayments('user-a');
    expect(mocks.paymentFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-a' } }));

    await getLedgerSummary('user-a');
    expect(mocks.ledgerFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-a' } }));
    expect(mocks.ledgerAggregate).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-a' } }));

    await getWalletHistory('user-a');
    expect(mocks.usageFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-a' } }));
  });

  it('keeps every user-owned HTTP route bound to the authenticated identity', () => {
    expect(existsSync(resolve(process.cwd(), 'app/api/chats/route.ts'))).toBe(false);
    expect(source('app/api/conversations/route.ts')).toMatch(/getUserConversations\(user\.id/);
    expect(source('app/api/conversations/[id]/route.ts')).toMatch(/validateConversationOwnership\(conversationId, user\.id\)/);
    expect(source('app/api/conversations/[id]/rename/route.ts')).toMatch(/validateConversationOwnership\(conversationId, user\.id\)/);
    expect(source('app/api/conversations/[id]/pin/route.ts')).toMatch(/validateConversationOwnership\(conversationId, user\.id\)/);
    expect(source('app/api/conversations/[id]/unpin/route.ts')).toMatch(/validateConversationOwnership\(conversationId, user\.id\)/);
    expect(source('app/api/chat/[id]/route.ts')).toMatch(/conv\.userId !== user\.id/);
    expect(source('app/api/chat/message/edit/route.ts')).toMatch(/conversation\.userId !== user\.id/);
    expect(source('app/api/chat/message/delete/route.ts')).toMatch(/conversation\.userId !== user\.id/);
    expect(source('app/api/chat/message/feedback/route.ts')).toMatch(/conversation\.userId !== user\.id/);
    expect(source('app/api/chat/message/regenerate/route.ts')).toMatch(/conversation\.userId !== user\.id/);
    expect(source('app/api/wallet/route.ts')).toMatch(/getWalletSummary\(user\.id\)/);
    expect(source('app/api/wallet/history/route.ts')).toMatch(/getWalletHistory\(user\.id\)/);
    expect(source('app/api/wallet/usage/route.ts')).toMatch(/getWalletUsage\(user\.id\)/);
    expect(source('app/api/wallet/summary/route.ts')).toMatch(/const userId = user\.id/);
    expect(source('app/api/payments/route.ts')).toMatch(/getPayment\(user\.id, paymentId\)/);
    expect(source('app/api/payments/route.ts')).toMatch(/listPayments\(user\.id\)/);
    expect(source('app/api/payments/manage-subscription/route.ts')).toMatch(/createPaddleCustomerPortalForUser\(user\.id\)/);
    expect(source('app/api/support/reports/route.ts')).toMatch(/where:\s*\{\s*id: report\.conversationId, userId: user\.id/);
    expect(source('app/api/support/reports/route.ts')).toMatch(/conversation:\s*\{\s*userId: user\.id\s*\}/);
    expect(source('app/api/live-tutor/session/route.ts')).toMatch(/getOwnedLiveTutorConversation\(requestedConversationId, user\.id\)/);
    expect(source('app/api/auth/sessions/route.ts')).toMatch(/where:\s*\{\s*userId: user\.id\s*\}/);
    expect(source('app/api/me/consent/route.ts')).toMatch(/WHERE "userId" = \$\{user\.id\}/);
    expect(source('app/api/me/profile/route.ts')).toMatch(/const user = await getUserFromRequest\(req\)/);
  });
});
