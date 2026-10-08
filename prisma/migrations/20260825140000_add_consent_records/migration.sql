CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "privacyVersion" TEXT NOT NULL,
    "termsVersion" TEXT NOT NULL,
    "aiNoticeVersion" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'android',
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConsentRecord_userId_privacyVersion_termsVersion_aiNoticeVersion_key"
ON "ConsentRecord"("userId", "privacyVersion", "termsVersion", "aiNoticeVersion");

CREATE INDEX "ConsentRecord_userId_acceptedAt_idx" ON "ConsentRecord"("userId", "acceptedAt");

ALTER TABLE "ConsentRecord"
ADD CONSTRAINT "ConsentRecord_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
