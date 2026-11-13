-- CreateEnum
CREATE TYPE "StoreBusinessType" AS ENUM ('RETAIL', 'FOOD_AND_BEVERAGE', 'FASHION_AND_WEARABLES', 'HEALTH_AND_BEAUTY', 'ELECTRONICS', 'PROFESSIONAL_SERVICES', 'AGRICULTURE', 'OTHER');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('NGN', 'USD', 'GHS', 'KES', 'ZAR');

-- AlterTable: the new profile columns are required, but the dev store
-- row (and any pre-existing row) has no value for them. Add them
-- nullable, backfill the legacy row, then tighten to NOT NULL.
ALTER TABLE "Store" ADD COLUMN "businessPhone" TEXT;
ALTER TABLE "Store" ADD COLUMN "businessType" "StoreBusinessType";
ALTER TABLE "Store" ADD COLUMN "currency" "Currency" NOT NULL DEFAULT 'NGN';
ALTER TABLE "Store" ADD COLUMN "location" TEXT;
ALTER TABLE "Store" ALTER COLUMN "subdomain" DROP NOT NULL;

UPDATE "Store"
SET "businessType" = 'OTHER',
    "location" = '',
    "businessPhone" = ''
WHERE "businessType" IS NULL;

ALTER TABLE "Store" ALTER COLUMN "businessPhone" SET NOT NULL;
ALTER TABLE "Store" ALTER COLUMN "businessType" SET NOT NULL;
ALTER TABLE "Store" ALTER COLUMN "location" SET NOT NULL;
