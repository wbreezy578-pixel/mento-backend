CREATE TABLE "ChatOperation" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "clientRequestId" TEXT NOT NULL,
  "operationType" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "conversationId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
  "responseText" TEXT,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ChatOperation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatOperation_userId_clientRequestId_operationType_key"
ON "ChatOperation"("userId", "clientRequestId", "operationType");
CREATE INDEX "ChatOperation_conversationId_idx" ON "ChatOperation"("conversationId");
CREATE INDEX "ChatOperation_status_expiresAt_idx" ON "ChatOperation"("status", "expiresAt");

ALTER TABLE "ChatOperation"
ADD CONSTRAINT "ChatOperation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatOperation"
ADD CONSTRAINT "ChatOperation_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
