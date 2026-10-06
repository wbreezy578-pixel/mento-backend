ALTER TABLE "WebsiteDeployment"
  ALTER COLUMN "status" SET DEFAULT 'building',
  ADD COLUMN "r2Prefix" TEXT,
  ADD COLUMN "manifestKey" TEXT,
  ADD COLUMN "artifactHash" TEXT,
  ADD COLUMN "artifactSize" INTEGER;

CREATE TABLE "WebsiteDomain" (
  "id" TEXT NOT NULL,
  "hostname" TEXT NOT NULL,
  "websiteId" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'mento_subdomain',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WebsiteDomain_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WebsiteDomain_hostname_key" ON "WebsiteDomain"("hostname");
CREATE INDEX "WebsiteDomain_websiteId_status_idx" ON "WebsiteDomain"("websiteId", "status");

ALTER TABLE "WebsiteDomain"
  ADD CONSTRAINT "WebsiteDomain_websiteId_fkey"
  FOREIGN KEY ("websiteId") REFERENCES "Website"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
