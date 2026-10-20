ALTER TABLE "WebsiteAsset"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "r2ObjectKey" TEXT,
  ADD COLUMN "providerImageUrl" TEXT,
  ADD COLUMN "providerTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "searchQuery" TEXT,
  ADD COLUMN "retrievedAt" TIMESTAMP(3),
  ADD COLUMN "licenseName" TEXT,
  ADD COLUMN "licenseUrl" TEXT,
  ADD COLUMN "attributionRequired" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "WebsiteAsset_r2ObjectKey_key" ON "WebsiteAsset"("r2ObjectKey");
