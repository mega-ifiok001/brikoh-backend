-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'RECEIPT';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "receiptEmail" VARCHAR(320);
