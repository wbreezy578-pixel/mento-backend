import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(path, 'utf8');

describe('authoritative entitlement foundation', () => {
  it('uses durable unique provider and minute-ledger identities', () => {
    const schema = source('prisma/schema.prisma');
    expect(schema).toMatch(/@@unique\(\[provider, externalEventId\]\)/);
    expect(schema).toMatch(/idempotencyKey\s+String\s+@unique/);
    expect(schema).toMatch(/includedSeconds\s+Int\s+@default\(0\)/);
    expect(schema).toMatch(/topUpSeconds\s+Int\s+@default\(0\)/);
  });

  it('enforces non-negative balances in the database migration', () => {
    const migration = source('prisma/migrations/20260902120000_add_canonical_entitlements/migration.sql');
    expect(migration).toContain('LiveTutorWallet_nonnegative_balances');
    expect(migration).toMatch(/"includedSeconds" >= 0 AND "topUpSeconds" >= 0/);
    expect(migration).not.toMatch(/SET "topUpSeconds" = "minutesBalance" \* 60/);
  });

  it('uses serializable transactions and row locks for credits and consumption', () => {
    const service = source('services/entitlementService.ts');
    expect(service).toMatch(/TransactionIsolationLevel\.Serializable/g);
    expect(service).toMatch(/FOR UPDATE/);
    expect(service).toMatch(/findUnique\(\{ where: \{ idempotencyKey:/);
  });

  it('binds entitlement retrieval to the authenticated server user', () => {
    const route = source('app/api/entitlements/route.ts');
    expect(route).toMatch(/getUserFromRequest\(req\)/);
    expect(route).toMatch(/getEntitlementSnapshot\(user\.id\)/);
    expect(route).not.toMatch(/req\.json/);
  });

  it('keeps model and allowance decisions server-owned', () => {
    const gateway = source('lib/aiSecurityGateway.ts');
    const billing = source('services/billingService.ts');
    expect(billing).toMatch(/resolvePolicyModel\(plan\.name, requestedModel\)/);
    expect(billing).toMatch(/SELECT id FROM "UserWallet" WHERE "userId" = \$\{userId\} FOR UPDATE/);
    expect(gateway).toContain("code: 'product_allowance_exhausted'");
  });

  it('preserves provider accounting independently from product allowance', () => {
    const schema = source('prisma/schema.prisma');
    expect(schema).toMatch(/providerCostUSD\s+Float/);
    expect(schema).toMatch(/providerExposureUSD\s+Float/);
    expect(schema).toMatch(/userChargeUSD\s+Float/);
  });
});
