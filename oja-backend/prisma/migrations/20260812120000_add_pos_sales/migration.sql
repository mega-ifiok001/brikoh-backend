-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'TRANSFER', 'CREDIT', 'CARD');

-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('STOREFRONT', 'POS');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "paymentMethod" "PaymentMethod",
ADD COLUMN     "amountPaid" DECIMAL(10,2),
ADD COLUMN     "source" "OrderSource" NOT NULL DEFAULT 'STOREFRONT',
ADD COLUMN     "discountAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;