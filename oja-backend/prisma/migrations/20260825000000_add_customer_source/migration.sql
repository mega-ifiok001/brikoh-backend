-- Customer provenance (analytics enrichment): where each row first came
-- from. Default MANUAL keeps existing rows honest (they were all created
-- through the dashboard before this phase).

CREATE TYPE "CustomerSource" AS ENUM ('POS', 'MANUAL', 'STOREFRONT', 'IMPORTED');

ALTER TABLE "Customer" ADD COLUMN "source" "CustomerSource" NOT NULL DEFAULT 'MANUAL';