ALTER TABLE "Conversation"
  ADD COLUMN "summary" TEXT,
  ADD COLUMN "summaryUpdatedAt" TIMESTAMP(3);

CREATE TABLE "ChatAnalyticsEvent" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "conversationId" TEXT,
  "messageId" TEXT,
  "eventType" TEXT NOT NULL,
  "promptHash" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatAnalyticsEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ChatAnalyticsEvent_userId_eventType_createdAt_idx"
  ON "ChatAnalyticsEvent"("userId", "eventType", "createdAt");
CREATE INDEX "ChatAnalyticsEvent_conversationId_createdAt_idx"
  ON "ChatAnalyticsEvent"("conversationId", "createdAt");
CREATE INDEX "ChatAnalyticsEvent_promptHash_createdAt_idx"
  ON "ChatAnalyticsEvent"("promptHash", "createdAt");

ALTER TABLE "ChatAnalyticsEvent"
  ADD CONSTRAINT "ChatAnalyticsEvent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatAnalyticsEvent"
  ADD CONSTRAINT "ChatAnalyticsEvent_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
