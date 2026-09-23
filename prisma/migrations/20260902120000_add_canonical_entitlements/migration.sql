ALTER TABLE "UserWallet"
ADD COLUMN "subscriptionStartedAt" TIMESTAMP(3),
ADD COLUMN "subscriptionPeriodStart" TIMESTAMP(3),
ADD COLUMN "entitlementSource" TEXT NOT NULL DEFAULT 'SYSTEM',
ADD COLUMN "entitlementExternalId" TEXT,
ADD COLUMN "entitlementUpdatedAt" TIMESTAMP(3);

ALTER TABLE "LiveTutorWallet"
ADD COLUMN "includedSeconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "topUpSeconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "includedPeriodStart" TIMESTAMP(3),
ADD COLUMN "includedPeriodEnd" TIMESTAMP(3);

-- Legacy minutesBalance has mixed/unknown provenance (subscription, purchased,
-- promotional, or administrative). It remains available to the legacy Live
-- Tutor path until an explicit, audited backfill classifies it. Never promote
-- unknown legacy value into the purchased top-up bucket automatically.

CREATE TABLE "EntitlementEvent" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "externalEventId" TEXT NOT NULL,
  "externalTransactionId" TEXT,
  "eventType" TEXT NOT NULL,
  "planName" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "periodStart" TIMESTAMP(3),
  "periodEnd" TIMESTAMP(3),
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EntitlementEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LiveTutorMinuteLedger" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "walletId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "entryType" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "includedSecondsDelta" INTEGER NOT NULL DEFAULT 0,
  "topUpSecondsDelta" INTEGER NOT NULL DEFAULT 0,
  "includedSecondsAfter" INTEGER NOT NULL,
  "topUpSecondsAfter" INTEGER NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LiveTutorMinuteLedger_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UserWallet_entitlementSource_entitlementExternalId_idx" ON "UserWallet"("entitlementSource", "entitlementExternalId");
CREATE INDEX "UserWallet_subscriptionStatus_subscriptionExpiresAt_idx" ON "UserWallet"("subscriptionStatus", "subscriptionExpiresAt");
CREATE UNIQUE INDEX "EntitlementEvent_provider_externalEventId_key" ON "EntitlementEvent"("provider", "externalEventId");
CREATE INDEX "EntitlementEvent_userId_occurredAt_idx" ON "EntitlementEvent"("userId", "occurredAt");
CREATE INDEX "EntitlementEvent_provider_externalTransactionId_idx" ON "EntitlementEvent"("provider", "externalTransactionId");
CREATE UNIQUE INDEX "LiveTutorMinuteLedger_idempotencyKey_key" ON "LiveTutorMinuteLedger"("idempotencyKey");
CREATE INDEX "LiveTutorMinuteLedger_userId_createdAt_idx" ON "LiveTutorMinuteLedger"("userId", "createdAt");
CREATE INDEX "LiveTutorMinuteLedger_walletId_createdAt_idx" ON "LiveTutorMinuteLedger"("walletId", "createdAt");

ALTER TABLE "EntitlementEvent" ADD CONSTRAINT "EntitlementEvent_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LiveTutorMinuteLedger" ADD CONSTRAINT "LiveTutorMinuteLedger_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LiveTutorMinuteLedger" ADD CONSTRAINT "LiveTutorMinuteLedger_walletId_fkey"
FOREIGN KEY ("walletId") REFERENCES "LiveTutorWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LiveTutorWallet" ADD CONSTRAINT "LiveTutorWallet_nonnegative_balances"
CHECK ("includedSeconds" >= 0 AND "topUpSeconds" >= 0 AND "minutesBalance" >= 0);
