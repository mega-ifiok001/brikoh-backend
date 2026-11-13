-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_deliveryZoneId_fkey";

-- DropTable
DROP TABLE "DeliveryZone";

-- AlterTable
ALTER TABLE "Order" DROP COLUMN "deliveryZoneId",
DROP COLUMN "deliveryZoneName",
ADD COLUMN     "deliveryCity" VARCHAR(120),
ADD COLUMN     "deliveryState" VARCHAR(120),
ADD COLUMN     "deliveryPhone" VARCHAR(30),
ADD COLUMN     "deliveryInstructions" VARCHAR(500);
