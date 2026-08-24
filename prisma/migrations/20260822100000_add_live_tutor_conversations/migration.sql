ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'chat';

ALTER TABLE "LiveTutorSession" ADD COLUMN IF NOT EXISTS "conversationId" TEXT;

CREATE INDEX IF NOT EXISTS "Conversation_userId_source_updatedAt_idx" ON "Conversation"("userId", "source", "updatedAt");
CREATE INDEX IF NOT EXISTS "LiveTutorSession_conversationId_idx" ON "LiveTutorSession"("conversationId");

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'LiveTutorSession_conversationId_fkey'
			AND conrelid = '"LiveTutorSession"'::regclass
	) THEN
		ALTER TABLE "LiveTutorSession"
			ADD CONSTRAINT "LiveTutorSession_conversationId_fkey"
			FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
			ON DELETE SET NULL ON UPDATE CASCADE;
	END IF;
END $$;