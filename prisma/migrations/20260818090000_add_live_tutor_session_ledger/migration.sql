CREATE TABLE "LiveTutorSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "streamId" TEXT NOT NULL,
    "billingRequestId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'creating',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "secondsReserved" INTEGER NOT NULL DEFAULT 60,
    "secondsConsumed" INTEGER NOT NULL DEFAULT 0,
    "billingFinalized" BOOLEAN NOT NULL DEFAULT false,
    "terminalStatus" TEXT,
    "terminalReason" TEXT,
    "finalizedAt" TIMESTAMP(3),
    CONSTRAINT "LiveTutorSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LiveTutorSession_userId_key" ON "LiveTutorSession"("userId");
CREATE UNIQUE INDEX "LiveTutorSession_streamId_key" ON "LiveTutorSession"("streamId");
CREATE UNIQUE INDEX "LiveTutorSession_billingRequestId_key" ON "LiveTutorSession"("billingRequestId");
CREATE INDEX "LiveTutorSession_status_lastActivityAt_idx" ON "LiveTutorSession"("status", "lastActivityAt");
CREATE INDEX "LiveTutorSession_expiresAt_idx" ON "LiveTutorSession"("expiresAt");
ALTER TABLE "LiveTutorSession" ADD CONSTRAINT "LiveTutorSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;