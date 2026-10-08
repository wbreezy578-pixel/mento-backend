ALTER TABLE "Website"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'draft',
  ADD COLUMN "publishedVersion" INTEGER,
  ADD COLUMN "deletedAt" TIMESTAMP(3);

ALTER TABLE "WebsiteVersion"
  ADD COLUMN "changeType" TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN "createdBy" TEXT;

CREATE INDEX "Website_userId_status_deletedAt_idx"
  ON "Website"("userId", "status", "deletedAt");
