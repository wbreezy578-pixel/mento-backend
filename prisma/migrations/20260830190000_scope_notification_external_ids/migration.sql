DROP INDEX IF EXISTS "Notification_externalId_key";

CREATE UNIQUE INDEX "Notification_userId_externalId_key"
ON "Notification"("userId", "externalId");
