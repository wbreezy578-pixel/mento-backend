CREATE TABLE "Website" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Website_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebsiteVersion" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebsiteVersion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Website_userId_updatedAt_idx" ON "Website"("userId", "updatedAt");
CREATE UNIQUE INDEX "WebsiteVersion_websiteId_version_key" ON "WebsiteVersion"("websiteId", "version");
CREATE INDEX "WebsiteVersion_websiteId_createdAt_idx" ON "WebsiteVersion"("websiteId", "createdAt");

ALTER TABLE "Website" ADD CONSTRAINT "Website_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WebsiteVersion" ADD CONSTRAINT "WebsiteVersion_websiteId_fkey"
  FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;