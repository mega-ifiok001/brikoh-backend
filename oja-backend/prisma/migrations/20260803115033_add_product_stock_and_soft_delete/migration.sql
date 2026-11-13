-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "deletedAt" TIMESTAMPTZ(3),
ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 0;

-- Stock can never go negative: enforced both here (DB CHECK) and by the
-- atomic conditional UPDATE in ledger.service (which also guards the
-- concurrent-over-sell case the CHECK cannot catch by itself).
ALTER TABLE "Product"
  ADD CONSTRAINT "product_quantity_non_negative" CHECK ("quantity" >= 0);

-- CreateIndex
CREATE INDEX "Product_storeId_createdAt_idx" ON "Product"("storeId", "createdAt");
