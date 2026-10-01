ALTER TABLE "UserWallet" ADD COLUMN "paddleLastEventAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "UserWallet_paddleCustomerId_key" ON "UserWallet"("paddleCustomerId");
CREATE UNIQUE INDEX "UserWallet_paddleSubscriptionId_key" ON "UserWallet"("paddleSubscriptionId");

ALTER TABLE "PaymentLedgerEntry" ADD COLUMN "amountMinor" INTEGER NOT NULL DEFAULT 0;

UPDATE "PaymentLedgerEntry"
SET "amountMinor" = ROUND("amountUsd" * 100)::INTEGER
WHERE "amountMinor" = 0;

WITH ranked_entries AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "transactionId", "entryType" ORDER BY "createdAt", "id") AS duplicate_rank
  FROM "PaymentLedgerEntry"
)
UPDATE "PaymentLedgerEntry" AS ledger
SET "entryType" = ledger."entryType" || ':LEGACY_DUPLICATE:' || ledger."id"
FROM ranked_entries
WHERE ledger."id" = ranked_entries."id" AND ranked_entries.duplicate_rank > 1;

CREATE UNIQUE INDEX "PaymentLedgerEntry_transactionId_entryType_key"
ON "PaymentLedgerEntry"("transactionId", "entryType");

CREATE TABLE "PaymentWebhookEvent" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "notificationId" TEXT,
  "eventType" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "rawPayload" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RECEIVED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "processedAt" TIMESTAMP(3),
  "transactionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaymentWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentWebhookEvent_provider_eventId_key"
ON "PaymentWebhookEvent"("provider", "eventId");

CREATE INDEX "PaymentWebhookEvent_status_createdAt_idx"
ON "PaymentWebhookEvent"("status", "createdAt");

CREATE INDEX "PaymentWebhookEvent_notificationId_idx"
ON "PaymentWebhookEvent"("notificationId");

ALTER TABLE "PaymentWebhookEvent"
ADD CONSTRAINT "PaymentWebhookEvent_transactionId_fkey"
FOREIGN KEY ("transactionId") REFERENCES "PaymentTransaction"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
