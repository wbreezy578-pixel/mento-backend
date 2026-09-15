ALTER TABLE "Conversation"
ADD COLUMN "summaryThroughMessageId" TEXT,
ADD COLUMN "summaryThroughCreatedAt" TIMESTAMP(3),
ADD COLUMN "summaryRevision" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "Conversation_summaryThroughCreatedAt_idx"
ON "Conversation"("summaryThroughCreatedAt");
