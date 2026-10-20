CREATE TABLE "WebsiteImageGenerationQuota" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "monthStart" DATE NOT NULL,
    "generatedImages" INTEGER NOT NULL DEFAULT 0,
    "reservedImages" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebsiteImageGenerationQuota_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebsiteImageGenerationReservation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "monthStart" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "WebsiteImageGenerationReservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WebsiteImageGenerationQuota_userId_monthStart_key"
ON "WebsiteImageGenerationQuota"("userId", "monthStart");
CREATE INDEX "WebsiteImageGenerationQuota_monthStart_idx"
ON "WebsiteImageGenerationQuota"("monthStart");
CREATE INDEX "WebsiteImageGenerationReservation_userId_monthStart_status_createdAt_idx"
ON "WebsiteImageGenerationReservation"("userId", "monthStart", "status", "createdAt");

ALTER TABLE "WebsiteImageGenerationQuota"
ADD CONSTRAINT "WebsiteImageGenerationQuota_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebsiteImageGenerationReservation"
ADD CONSTRAINT "WebsiteImageGenerationReservation_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
