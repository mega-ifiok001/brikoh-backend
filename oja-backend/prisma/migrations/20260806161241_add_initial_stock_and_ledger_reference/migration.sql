-- AlterEnum
ALTER TYPE "StockReason" ADD VALUE 'INITIAL_STOCK';

-- AlterTable
ALTER TABLE "StockLedgerEntry" ADD COLUMN     "referenceId" TEXT;
