-- Pending AI usage must be distinct from denied or rolled-back usage so that
-- concurrent reservations count toward plan limits without becoming charges.
ALTER TABLE "UsageLog" ALTER COLUMN "success" DROP NOT NULL;

UPDATE "UsageLog"
SET "success" = NULL
WHERE "success" = FALSE
  AND COALESCE("metadata"->>'reason', '') IN (
    'Usage reservation pending.',
    'Live tutor reservation pending.'
  )
  AND "createdAt" >= NOW() - INTERVAL '5 minutes';
