ALTER TABLE "LiveTutorSession" ADD COLUMN "ownerProcessId" TEXT;
ALTER TABLE "LiveTutorSession" ADD COLUMN "finalizationStartedAt" TIMESTAMP(3);

CREATE INDEX "LiveTutorSession_ownerProcessId_idx" ON "LiveTutorSession"("ownerProcessId");