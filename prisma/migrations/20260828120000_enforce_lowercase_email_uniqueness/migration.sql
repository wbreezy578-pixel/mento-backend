-- Normalize existing account addresses before adding the case-insensitive
-- invariant.  Refuse to guess which account owns a collision; resolve any
-- duplicate manually and rerun this migration.
DO $$
BEGIN
  IF EXISTS (
    SELECT lower(trim("email"))
    FROM "User"
    GROUP BY lower(trim("email"))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce lowercase email uniqueness while duplicate normalized addresses exist';
  END IF;
END $$;

UPDATE "User"
SET "email" = lower(trim("email"));

UPDATE "User"
SET "pendingEmail" = lower(trim("pendingEmail"))
WHERE "pendingEmail" IS NOT NULL;

CREATE UNIQUE INDEX "User_email_lower_key" ON "User" (lower("email"));
