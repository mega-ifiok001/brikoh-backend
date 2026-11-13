-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "coverImageUrl" VARCHAR(2048),
ADD COLUMN     "discountPrice" DECIMAL(10,2),
ADD COLUMN     "expiryDate" TIMESTAMPTZ(3),
ADD COLUMN     "lowStockThreshold" INTEGER,
ADD COLUMN     "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT';

-- Backfill: products that existed before the publish gate were live
-- storefront items — they must stay buyable (PUBLISHED) instead of
-- silently disappearing from checkout behind the new DRAFT default.
UPDATE "Product" SET "status" = 'PUBLISHED';
