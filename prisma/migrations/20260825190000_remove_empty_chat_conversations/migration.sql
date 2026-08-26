DELETE FROM "Conversation" AS conversation
WHERE conversation."source" = 'chat'
  AND NOT EXISTS (
    SELECT 1
    FROM "ConversationMessage" AS message
    WHERE message."conversationId" = conversation."id"
  );
