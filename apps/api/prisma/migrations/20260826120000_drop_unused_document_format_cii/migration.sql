BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "GeneratedDocument" WHERE "format" = 'XRECHNUNG_CII') THEN
    RAISE EXCEPTION 'Cannot remove XRECHNUNG_CII while generated documents use it';
  END IF;
END $$;

CREATE TYPE "DocumentFormat_new" AS ENUM ('XRECHNUNG_UBL');

ALTER TABLE "GeneratedDocument"
  ALTER COLUMN "format" TYPE "DocumentFormat_new"
  USING ("format"::text::"DocumentFormat_new");

DROP TYPE "DocumentFormat";
ALTER TYPE "DocumentFormat_new" RENAME TO "DocumentFormat";

COMMIT;
