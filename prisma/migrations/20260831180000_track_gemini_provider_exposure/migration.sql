ALTER TABLE "UsageLog"
ADD COLUMN "providerExposureUSD" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "providerAttemptCount" INTEGER NOT NULL DEFAULT 0;

-- Existing pending Gemini reservations stored their conservative hold in
-- providerCostUSD. Move that hold into providerExposureUSD without claiming
-- it is actual provider spend.
UPDATE "UsageLog"
SET
  "providerExposureUSD" = "providerCostUSD",
  "providerCostUSD" = 0
WHERE "provider" = 'Gemini'
  AND "success" IS NULL;

-- Preserve budget protection for existing non-completed Gemini work where the
-- provider may have run but authoritative usage was unavailable. The value
-- matches the pre-existing server default reservation; it is exposure, not
-- reported spend.
UPDATE "UsageLog"
SET
  "providerExposureUSD" = GREATEST("providerExposureUSD", 0.5),
  "providerAttemptCount" = GREATEST("providerAttemptCount", 1)
WHERE "provider" = 'Gemini'
  AND "success" = FALSE
  AND "usageSource" = 'UNKNOWN'
  AND "providerCostUSD" = 0
  AND ("metadata"->>'generationOutcome') IN ('cancelled', 'persistence_failed', 'provider_failed');
