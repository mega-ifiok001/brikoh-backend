-- AlterTable: coupon limits on Discount (dashboard-discounts.md). A
-- discount with a code that carries any of these becomes a coupon —
-- enforced at sale time, every successful use writes a CouponRedemption.
ALTER TABLE "Discount" ADD COLUMN "maxUses" INTEGER;
ALTER TABLE "Discount" ADD COLUMN "perCustomerUses" INTEGER DEFAULT 1;
ALTER TABLE "Discount" ADD COLUMN "minSubtotal" DECIMAL(10,2);
ALTER TABLE "Discount" ADD COLUMN "firstOrderOnly" BOOLEAN;

-- CreateTable: time-boxed storefront promotions. SetNull on discount
-- deletion: the banner just loses its code, order money is untouched.
CREATE TABLE "Campaign" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3),
    "endsAt" TIMESTAMPTZ(3),
    "bannerTitle" TEXT,
    "bannerSubtitle" TEXT,
    "ctaLabel" TEXT,
    "discountId" UUID,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable: coupon usage records, one per successful coupon
-- application, written in the same transaction as its order. Cascade
-- with order and discount; captured order money always survives.
CREATE TABLE "CouponRedemption" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "discountId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CouponRedemption_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "Campaign_storeId_idx" ON "Campaign"("storeId");
CREATE INDEX "Campaign_storeId_isActive_idx" ON "Campaign"("storeId", "isActive");
CREATE INDEX "CouponRedemption_storeId_idx" ON "CouponRedemption"("storeId");
CREATE INDEX "CouponRedemption_discountId_idx" ON "CouponRedemption"("discountId");
CREATE INDEX "CouponRedemption_customerId_idx" ON "CouponRedemption"("customerId");
CREATE UNIQUE INDEX "CouponRedemption_orderId_key" ON "CouponRedemption"("orderId");

-- Foreign keys
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_discountId_fkey" FOREIGN KEY ("discountId") REFERENCES "Discount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_discountId_fkey" FOREIGN KEY ("discountId") REFERENCES "Discount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;