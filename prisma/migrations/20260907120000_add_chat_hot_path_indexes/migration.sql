-- Improve usage-limit counts and bounded conversation history reads.
CREATE INDEX "UsageLog_userId_feature_success_createdAt_idx"
  ON "UsageLog" ("userId", "feature", "success", "createdAt");

CREATE INDEX "ConversationMessage_conversationId_status_role_createdAt_idx"
  ON "ConversationMessage" ("conversationId", "status", "role", "createdAt");
