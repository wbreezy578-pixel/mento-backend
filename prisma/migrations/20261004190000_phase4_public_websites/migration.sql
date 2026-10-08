ALTER TABLE "Website"
  ADD COLUMN "slug" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "publishedDeploymentId" TEXT;

CREATE TABLE "WebsiteDeployment" (
  "id" TEXT NOT NULL,
  "websiteId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ready',
  "storagePath" TEXT,
  "hostname" TEXT,
  "publishedAt" TIMESTAMP(3),
  "unpublishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebsiteDeployment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebsiteReport" (
  "id" TEXT NOT NULL,
  "websiteId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "reporterEmail" TEXT,
  "status" TEXT NOT NULL DEFAULT 'open',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  CONSTRAINT "WebsiteReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WebsiteDeployment_websiteId_version_idx"
  ON "WebsiteDeployment" ("websiteId", "version");

CREATE INDEX "WebsiteDeployment_websiteId_status_publishedAt_idx"
  ON "WebsiteDeployment" ("websiteId", "status", "publishedAt");

CREATE INDEX "WebsiteReport_websiteId_status_createdAt_idx"
  ON "WebsiteReport" ("websiteId", "status", "createdAt");

ALTER TABLE "WebsiteDeployment"
  ADD CONSTRAINT "WebsiteDeployment_websiteId_fkey"
  FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WebsiteReport"
  ADD CONSTRAINT "WebsiteReport_websiteId_fkey"
  FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;
