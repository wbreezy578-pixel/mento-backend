import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const billingSource = fs.readFileSync(
  path.join(process.cwd(), 'services/billingService.ts'),
  'utf8',
);

function reserveUsageBody() {
  const start = billingSource.indexOf('export async function reserveUsage(');
  const end = billingSource.indexOf('\nexport async function ', start + 1);
  return billingSource.slice(start, end === -1 ? undefined : end);
}

describe('Normal Chat billing reservation path', () => {
  it('does not perform a user-specific preflight plan lookup', () => {
    const body = reserveUsageBody();

    expect(body).not.toContain('getEffectivePlanForUser');
    expect(body).toContain('await ensureDefaultPlans()');
    expect(body).toContain("defaultPlans.find((candidate) => candidate.name === 'FREE')");
  });

  it('reads and locks the authoritative wallet exactly once for chat/image reservations', () => {
    const body = reserveUsageBody();
    const walletRead = body.indexOf('resolveWalletAndPlanInTransaction(');
    const helperStart = billingSource.indexOf('async function resolveWalletAndPlanInTransaction(');
    const lockedWalletQuery = billingSource.indexOf('await lockWalletRow(tx, userId);', helperStart);

    expect(lockedWalletQuery).toBeGreaterThan(walletRead);
    expect(body).toContain('const { wallet, plan: effectivePlan } = await resolveWalletAndPlanInTransaction');
  });

  it('uses Prisma transaction reads for wallet and allowance counts', () => {
    const helperStart = billingSource.indexOf('async function resolveWalletAndPlanInTransaction(');
    const helperEnd = billingSource.indexOf('\nasync function createOrFindUserWallet', helperStart);
    const helper = billingSource.slice(helperStart, helperEnd);
    const body = reserveUsageBody();

    expect(helper).toContain('tx.userWallet.findUnique({');
    expect(helper).not.toContain('INNER JOIN "Plan"');
    expect(body).toContain('const usageWhere = {');
    expect(body).toContain('await tx.usageLog.count({');
  });

  it('keeps a safe diagnostic stage if an unclassified Gemini reservation error occurs', () => {
    const body = reserveUsageBody();

    expect(body).toContain("let reservationStage = 'transaction_start';");
    expect(body).toContain('stage: reservationStage');
    expect(body).toContain("reservationStage = 'ledger_write';");
    expect(body).toContain('throw new GeminiDailyBudgetUnavailableError();');
  });

  it('uses the authoritative in-transaction plan for idempotency, limits, and model binding', () => {
    const body = reserveUsageBody();
    const effectivePlan = body.indexOf('const { wallet, plan: effectivePlan }');
    const idempotencyRead = body.indexOf('const existing = validatedInput.requestId');
    const modelBinding = body.indexOf('resolvePlanModel(effectivePlan');
    const usageLimit = body.indexOf('getEffectiveLimit(effectivePlan');
    const reservationWrite = body.indexOf('createUsageLedgerEntry(');

    expect(effectivePlan).toBeGreaterThan(-1);
    expect(idempotencyRead).toBeGreaterThan(effectivePlan);
    expect(modelBinding).toBeGreaterThan(effectivePlan);
    expect(usageLimit).toBeGreaterThan(effectivePlan);
    expect(reservationWrite).toBeGreaterThan(usageLimit);
  });

  it('keeps budget enforcement inside the reservation transaction after idempotency check', () => {
    const body = reserveUsageBody();
    const idempotencyRead = body.indexOf('const existing = validatedInput.requestId');
    const budgetCheck = body.indexOf('assertAndLockGeminiDailyBudget(tx');
    const reservationWrite = body.indexOf('createUsageLedgerEntry(');

    expect(budgetCheck).toBeGreaterThan(idempotencyRead);
    expect(reservationWrite).toBeGreaterThan(budgetCheck);
  });
});
