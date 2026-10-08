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
    expect(body).toContain('await tx.$queryRaw<Array<{ dailyUsed: bigint; monthlyUsed: bigint }>>`');
    expect(body).toContain('COUNT(*) FILTER (WHERE "createdAt" >= ${windowStart}) AS "dailyUsed"');
    expect(body).toContain('COUNT(*) FILTER (WHERE "createdAt" >= ${monthlyStart} AND "createdAt" < ${monthlyEnd}) AS "monthlyUsed"');
    expect(body).toMatch(/AND\s+\(\s+success = TRUE\s+OR \(success IS NULL AND "createdAt" >= \$\{pendingCutoff\}\)\s+\)/);
    expect(body).toContain('used = await tx.usageLog.count({');
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

  it('enforces website Pro, project, and successful AI-edit quotas inside the reservation transaction', () => {
    const body = reserveUsageBody();
    const idempotencyRead = body.indexOf('const existing = validatedInput.requestId');
    const projectQuota = body.indexOf('websiteProjectLimitExceeded = createdProjects + pendingCreations');
    const editQuota = body.indexOf('websiteEditLimitExceeded = editsInPeriod + validatedInput.amount');
    const reservationWrite = body.lastIndexOf('const successRecord = await createUsageLedgerEntry(');

    expect(body).toContain("validatedInput.feature === 'website' && effectivePlan.name !== 'PRO'");
    expect(body).toContain("metadata: { path: ['operationType'], equals: 'website.ai_edit' }");
    expect(body).toContain('{ success: true },');
    expect(body).toContain('{ success: null, createdAt: { gte: pendingCutoff } }');
    expect(projectQuota).toBeGreaterThan(idempotencyRead);
    expect(editQuota).toBeGreaterThan(idempotencyRead);
    expect(reservationWrite).toBeGreaterThan(projectQuota);
    expect(reservationWrite).toBeGreaterThan(editQuota);
  });

  it('records an allowed chat request as pending until the provider finishes', () => {
    const body = reserveUsageBody();
    const chatReservation = body.slice(body.indexOf('const pendingCutoff ='));

    expect(chatReservation).toMatch(/createUsageLedgerEntry\(\s*tx,\s*\{ \.\.\.reservationInput, pending: pendingReservation \},\s*effectivePlan,\s*true,/);
  });

  it('enforces the Free Learn daily cap from account-wide ledger rows inside the reservation transaction', () => {
    const body = reserveUsageBody();
    const learnCount = body.indexOf('learnDailyUsed = await tx.usageLog.count');
    const ledgerWrite = body.indexOf('createUsageLedgerEntry(', learnCount);

    expect(body).toContain("validatedInput.metadata?.source === 'learn'");
    expect(body).toContain("metadata: { path: ['source'], equals: 'learn' }");
    expect(body).toContain("feature: { in: ['chat', 'image'] }");
    expect(body).toContain("{ success: null, createdAt: { gte: pendingCutoff } }");
    expect(body).toContain('evaluateLearnDailyAllowance({ dailyUsed: learnDailyUsed');
    expect(learnCount).toBeGreaterThan(body.indexOf('resolveWalletAndPlanInTransaction('));
    expect(ledgerWrite).toBeGreaterThan(learnCount);
  });
});
