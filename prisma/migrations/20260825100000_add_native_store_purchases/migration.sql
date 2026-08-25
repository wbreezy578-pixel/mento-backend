CREATE TABLE "StorePurchase" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "paymentTransactionId" TEXT,
  "provider" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "purchaseToken" TEXT NOT NULL,
  "transactionId" TEXT,
  "originalTransactionId" TEXT,
  "purchaseType" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "purchasedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "autoRenewing" BOOLEAN,
  "acknowledged" BOOLEAN NOT NULL DEFAULT false,
  "consumed" BOOLEAN NOT NULL DEFAULT false,
  "environment" TEXT,
  "rawPayload" JSONB,
  "lastVerifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StorePurchase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StorePurchase_paymentTransactionId_key" ON "StorePurchase"("paymentTransactionId");
CREATE UNIQUE INDEX "StorePurchase_provider_purchaseToken_key" ON "StorePurchase"("provider", "purchaseToken");
CREATE INDEX "StorePurchase_userId_status_idx" ON "StorePurchase"("userId", "status");
CREATE INDEX "StorePurchase_provider_transactionId_idx" ON "StorePurchase"("provider", "transactionId");
CREATE INDEX "StorePurchase_provider_originalTransactionId_idx" ON "StorePurchase"("provider", "originalTransactionId");

ALTER TABLE "StorePurchase" ADD CONSTRAINT "StorePurchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StorePurchase" ADD CONSTRAINT "StorePurchase_paymentTransactionId_fkey" FOREIGN KEY ("paymentTransactionId") REFERENCES "PaymentTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
