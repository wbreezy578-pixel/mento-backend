CREATE TABLE "SupportReport" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "conversationId" TEXT,
  "messageId" TEXT,
  "source" TEXT NOT NULL DEFAULT 'android',
  "appVersion" TEXT,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SupportReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupportReport_userId_createdAt_idx" ON "SupportReport"("userId", "createdAt");
CREATE INDEX "SupportReport_status_createdAt_idx" ON "SupportReport"("status", "createdAt");
CREATE INDEX "SupportReport_conversationId_idx" ON "SupportReport"("conversationId");

ALTER TABLE "SupportReport"
ADD CONSTRAINT "SupportReport_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
