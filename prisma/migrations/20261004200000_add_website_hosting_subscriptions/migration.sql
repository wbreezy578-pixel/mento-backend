CREATE TABLE "WebsiteHostingSubscription" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "providerSubscriptionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebsiteHostingSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WebsiteHostingSubscription_websiteId_key" ON "WebsiteHostingSubscription"("websiteId");
CREATE UNIQUE INDEX "WebsiteHostingSubscription_providerSubscriptionId_key" ON "WebsiteHostingSubscription"("providerSubscriptionId");
CREATE INDEX "WebsiteHostingSubscription_status_currentPeriodEnd_idx" ON "WebsiteHostingSubscription"("status", "currentPeriodEnd");

ALTER TABLE "WebsiteHostingSubscription"
ADD CONSTRAINT "WebsiteHostingSubscription_websiteId_fkey"
FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;
