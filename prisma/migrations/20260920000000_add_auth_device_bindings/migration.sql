ALTER TABLE "Session" ADD COLUMN "deviceIdHash" TEXT;
ALTER TABLE "LoginChallenge" ADD COLUMN "deviceIdHash" TEXT;

CREATE INDEX "Session_userId_deviceIdHash_idx" ON "Session"("userId", "deviceIdHash");
