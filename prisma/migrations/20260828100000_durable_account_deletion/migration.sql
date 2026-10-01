ALTER TABLE "User" ADD COLUMN "oauthProvider" TEXT;
UPDATE "User" SET "oauthProvider" = "authProvider" WHERE "authProvider" IN ('google', 'apple');
UPDATE "User" SET "oauthProvider" = 'google' WHERE "authProvider" = 'mixed';

CREATE TABLE "AccountDeletionJob" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "supabaseUserId" TEXT,
  "paddleSubscriptionId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "paddleCanceledAt" TIMESTAMP(3),
  "googlePlayCanceledAt" TIMESTAMP(3),
  "supabaseDeletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "AccountDeletionJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccountDeletionJob_userId_key" ON "AccountDeletionJob"("userId");
CREATE INDEX "AccountDeletionJob_status_updatedAt_idx" ON "AccountDeletionJob"("status", "updatedAt");
