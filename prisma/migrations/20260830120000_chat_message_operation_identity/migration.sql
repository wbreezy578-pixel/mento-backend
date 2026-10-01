ALTER TABLE "ConversationMessage" ADD COLUMN "requestId" TEXT;

UPDATE "ConversationMessage" AS message
SET "userId" = conversation."userId"
FROM "Conversation" AS conversation
WHERE message."conversationId" = conversation."id"
  AND (message."userId" IS NULL OR message."userId" = '' OR message."userId" <> conversation."userId");

ALTER TABLE "ConversationMessage" ALTER COLUMN "userId" DROP DEFAULT;
ALTER TABLE "ConversationMessage" ALTER COLUMN "userId" SET NOT NULL;

ALTER TABLE "ConversationMessage"
ADD CONSTRAINT "ConversationMessage_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ConversationMessage_conversationId_requestId_role_key"
ON "ConversationMessage"("conversationId", "requestId", "role");
