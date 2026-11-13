-- CreateEnum
CREATE TYPE "DeliveryKind" AS ENUM ('PICKUP', 'DELIVERY');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "deliveryAddress" VARCHAR(500),
ADD COLUMN     "deliveryFee" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "deliveryKind" "DeliveryKind",
ADD COLUMN     "deliveryOptionId" UUID,
ADD COLUMN     "deliveryOptionName" VARCHAR(200),
ADD COLUMN     "deliveryZoneId" UUID,
ADD COLUMN     "deliveryZoneName" VARCHAR(200);

-- CreateTable
CREATE TABLE "DeliveryOption" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "kind" "DeliveryKind" NOT NULL,
    "description" VARCHAR(500),
    "baseFee" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "pickupLocationId" UUID,
    "pickupAddressText" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DeliveryOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryZone" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "deliveryOptionId" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "fee" DECIMAL(10,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryZone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliveryOption_storeId_idx" ON "DeliveryOption"("storeId");

-- CreateIndex
CREATE INDEX "DeliveryOption_storeId_isActive_sortOrder_idx" ON "DeliveryOption"("storeId", "isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "DeliveryOption_pickupLocationId_idx" ON "DeliveryOption"("pickupLocationId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryOption_storeId_name_key" ON "DeliveryOption"("storeId", "name");

-- CreateIndex
CREATE INDEX "DeliveryZone_storeId_idx" ON "DeliveryZone"("storeId");

-- CreateIndex
CREATE INDEX "DeliveryZone_deliveryOptionId_sortOrder_idx" ON "DeliveryZone"("deliveryOptionId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryZone_deliveryOptionId_name_key" ON "DeliveryZone"("deliveryOptionId", "name");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_deliveryOptionId_fkey" FOREIGN KEY ("deliveryOptionId") REFERENCES "DeliveryOption"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_deliveryZoneId_fkey" FOREIGN KEY ("deliveryZoneId") REFERENCES "DeliveryZone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryOption" ADD CONSTRAINT "DeliveryOption_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryOption" ADD CONSTRAINT "DeliveryOption_pickupLocationId_fkey" FOREIGN KEY ("pickupLocationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryZone" ADD CONSTRAINT "DeliveryZone_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryZone" ADD CONSTRAINT "DeliveryZone_deliveryOptionId_fkey" FOREIGN KEY ("deliveryOptionId") REFERENCES "DeliveryOption"("id") ON DELETE CASCADE ON UPDATE CASCADE;
