-- Corrective migration: the branches migration (20260807120000_add_branches)
-- was generated before the schema grew these three facts, so they never
-- reached the database. Service code and the schema already assume them:
--   1. StockReason TRANSFER_OUT/TRANSFER_IN — the transfer ledger legs
--      (branches module writes them on every stock transfer).
--   2. StockLedgerEntry.branchId nullable — SetNull on branch deletion
--      (ledger history keeps its rows, attribution becomes anonymous).
--   3. Branch (storeId, name) unique — the BRANCH_EXISTS service mapping
--      relies on the DB backstop for the find-then-create race.

-- AlterEnum
ALTER TYPE "StockReason" ADD VALUE 'TRANSFER_OUT';
ALTER TYPE "StockReason" ADD VALUE 'TRANSFER_IN';

-- AlterTable
ALTER TABLE "StockLedgerEntry" ALTER COLUMN "branchId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Branch_storeId_name_key" ON "Branch"("storeId", "name");
