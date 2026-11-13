-- AlterTable
ALTER TABLE "OrderLineItem" ADD COLUMN     "variantId" UUID;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "costPrice" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "StockLedgerEntry" ADD COLUMN     "variantId" UUID;

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sellingPrice" DECIMAL(10,2),
    "sku" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreActivityLog" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "staffMemberId" UUID,
    "action" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductVariant_storeId_idx" ON "ProductVariant"("storeId");

-- CreateIndex
CREATE INDEX "ProductVariant_productId_idx" ON "ProductVariant"("productId");

-- CreateIndex
CREATE INDEX "ProductVariant_productId_createdAt_idx" ON "ProductVariant"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "StoreActivityLog_storeId_createdAt_idx" ON "StoreActivityLog"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "StoreActivityLog_storeId_staffMemberId_idx" ON "StoreActivityLog"("storeId", "staffMemberId");

-- CreateIndex
CREATE INDEX "StoreActivityLog_staffMemberId_idx" ON "StoreActivityLog"("staffMemberId");

-- CreateIndex
CREATE INDEX "OrderLineItem_variantId_idx" ON "OrderLineItem"("variantId");

-- CreateIndex
CREATE INDEX "StockLedgerEntry_variantId_createdAt_idx" ON "StockLedgerEntry"("variantId", "createdAt");

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLedgerEntry" ADD CONSTRAINT "StockLedgerEntry_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreActivityLog" ADD CONSTRAINT "StoreActivityLog_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreActivityLog" ADD CONSTRAINT "StoreActivityLog_staffMemberId_fkey" FOREIGN KEY ("staffMemberId") REFERENCES "StaffMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- StoreActivityLog is append-only (same discipline as StockLedgerEntry and
-- AdminAuditLog). The pg_trigger_depth() = 0 guard lets cascades from the
-- tenant root (Store delete) pass while blocking direct UPDATE/DELETE.
CREATE OR REPLACE FUNCTION prevent_store_activity_log_mutation()
RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() = 0 THEN
    RAISE EXCEPTION 'StoreActivityLog is append-only: updates and deletes are not allowed';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER store_activity_log_append_only
BEFORE UPDATE OR DELETE ON "StoreActivityLog"
FOR EACH ROW EXECUTE FUNCTION prevent_store_activity_log_mutation();
