CREATE TABLE "WebsiteAsset" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "providerAssetId" TEXT,
    "objectKey" TEXT,
    "remoteUrl" TEXT,
    "sourcePageUrl" TEXT,
    "creatorName" TEXT,
    "creatorProfileUrl" TEXT,
    "alt" TEXT NOT NULL,
    "mimeType" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebsiteAsset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WebsiteAsset_objectKey_key" ON "WebsiteAsset"("objectKey");
CREATE INDEX "WebsiteAsset_websiteId_slotId_createdAt_idx" ON "WebsiteAsset"("websiteId", "slotId", "createdAt");
CREATE INDEX "WebsiteAsset_websiteId_providerAssetId_idx" ON "WebsiteAsset"("websiteId", "providerAssetId");

ALTER TABLE "WebsiteAsset" ADD CONSTRAINT "WebsiteAsset_websiteId_fkey"
  FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;