CREATE TYPE "WebsiteHostingTier" AS ENUM ('SITES_1', 'SITES_3', 'SITES_5');

CREATE TABLE "WebsiteHostingAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tier" "WebsiteHostingTier",
    "siteLimit" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'inactive',
    "provider" TEXT,
    "providerProductId" TEXT,
    "providerSubscriptionId" TEXT,
    "providerPurchaseTokenHash" TEXT,
    "currentPeriodStart" TIMESTAMP(3),
    "paidThroughAt" TIMESTAMP(3),
    "graceDeadlineAt" TIMESTAMP(3),
    "scheduledTier" "WebsiteHostingTier",
    "scheduledSiteLimit" INTEGER,
    "scheduledEffectiveAt" TIMESTAMP(3),
    "scheduledKeptWebsiteIds" JSONB,
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebsiteHostingAccount_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WebsiteHostingAccount_siteLimit_check"
      CHECK (
        ("tier" IS NULL AND "siteLimit" = 0)
        OR ("tier" = 'SITES_1' AND "siteLimit" = 1)
        OR ("tier" = 'SITES_3' AND "siteLimit" = 3)
        OR ("tier" = 'SITES_5' AND "siteLimit" = 5)
      )
);

CREATE UNIQUE INDEX "WebsiteHostingAccount_userId_key" ON "WebsiteHostingAccount"("userId");
CREATE UNIQUE INDEX "WebsiteHostingAccount_providerSubscriptionId_key" ON "WebsiteHostingAccount"("providerSubscriptionId");
CREATE UNIQUE INDEX "WebsiteHostingAccount_providerPurchaseTokenHash_key" ON "WebsiteHostingAccount"("providerPurchaseTokenHash");
CREATE INDEX "WebsiteHostingAccount_status_paidThroughAt_idx" ON "WebsiteHostingAccount"("status", "paidThroughAt");
CREATE INDEX "WebsiteHostingAccount_scheduledEffectiveAt_idx" ON "WebsiteHostingAccount"("scheduledEffectiveAt");

ALTER TABLE "WebsiteHostingAccount"
ADD CONSTRAINT "WebsiteHostingAccount_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
