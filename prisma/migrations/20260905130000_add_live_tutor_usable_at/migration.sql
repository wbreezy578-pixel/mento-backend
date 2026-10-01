ALTER TABLE "LiveTutorSession" ADD COLUMN "usableAt" TIMESTAMP(3);

CREATE INDEX "LiveTutorSession_usableAt_idx" ON "LiveTutorSession"("usableAt");
