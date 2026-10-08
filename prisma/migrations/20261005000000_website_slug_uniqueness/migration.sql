CREATE TEMP TABLE "_WebsiteSlugBackfill" (
  "id" TEXT PRIMARY KEY,
  "slug" TEXT NOT NULL UNIQUE
);

DO $$
DECLARE
  website_record RECORD;
  base_slug TEXT;
  candidate_slug TEXT;
  suffix INTEGER;
BEGIN
  FOR website_record IN
    SELECT "id", "slug", "title"
    FROM "Website"
    ORDER BY "createdAt", "id"
  LOOP
    base_slug := lower(replace(trim(coalesce(nullif(website_record."slug", ''), website_record."title")), '&', ' and '));
    base_slug := trim(both '-' from regexp_replace(base_slug, '[^a-z0-9]+', '-', 'g'));
    base_slug := regexp_replace(left(base_slug, 60), '-+$', '', 'g');
    IF base_slug = '' THEN
      base_slug := 'website';
    END IF;

    candidate_slug := base_slug;
    suffix := 2;
    WHILE EXISTS (
      SELECT 1
      FROM "_WebsiteSlugBackfill"
      WHERE "slug" = candidate_slug
    ) LOOP
      candidate_slug := rtrim(left(base_slug, greatest(1, 59 - length(suffix::TEXT))), '-') || '-' || suffix::TEXT;
      suffix := suffix + 1;
    END LOOP;

    INSERT INTO "_WebsiteSlugBackfill" ("id", "slug")
    VALUES (website_record."id", candidate_slug);

    UPDATE "Website"
    SET "slug" = candidate_slug
    WHERE "id" = website_record."id";
  END LOOP;
END $$;

UPDATE "WebsiteDeployment" AS deployment
SET "hostname" = website."slug" || '.mento.site'
FROM "Website" AS website
WHERE deployment."websiteId" = website."id"
  AND deployment."id" = website."publishedDeploymentId"
  AND deployment."status" = 'published'
  AND website."status" = 'published'
  AND website."deletedAt" IS NULL;

DROP TABLE "_WebsiteSlugBackfill";

ALTER TABLE "Website" ALTER COLUMN "slug" DROP DEFAULT;

CREATE UNIQUE INDEX "Website_slug_key" ON "Website"("slug");
