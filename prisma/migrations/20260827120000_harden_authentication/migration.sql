ALTER TABLE "User"
  ADD COLUMN "supabaseUserId" TEXT,
  ADD COLUMN "accountStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "credentialsChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "pendingEmail" TEXT;

CREATE UNIQUE INDEX "User_supabaseUserId_key" ON "User"("supabaseUserId");

CREATE TABLE "EmailActionToken" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "targetEmail" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "EmailActionToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmailActionToken_tokenHash_key" ON "EmailActionToken"("tokenHash");
CREATE INDEX "EmailActionToken_userId_purpose_idx" ON "EmailActionToken"("userId", "purpose");
CREATE INDEX "EmailActionToken_expiresAt_idx" ON "EmailActionToken"("expiresAt");
ALTER TABLE "EmailActionToken" ADD CONSTRAINT "EmailActionToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Session"
  ADD COLUMN "familyId" TEXT,
  ADD COLUMN "parentSessionId" TEXT,
  ADD COLUMN "absoluteExpiresAt" TIMESTAMP(3);
UPDATE "Session" SET "familyId" = "id", "absoluteExpiresAt" = LEAST("expiresAt" + INTERVAL '60 days', "createdAt" + INTERVAL '90 days');
ALTER TABLE "Session" ALTER COLUMN "familyId" SET NOT NULL;
ALTER TABLE "Session" ALTER COLUMN "absoluteExpiresAt" SET NOT NULL;
CREATE INDEX "Session_familyId_revokedAt_idx" ON "Session"("familyId", "revokedAt");
