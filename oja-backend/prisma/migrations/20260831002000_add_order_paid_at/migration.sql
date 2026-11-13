ALTER TABLE "Order" ADD COLUMN "paidAt" TIMESTAMPTZ(3);
CREATE INDEX "Order_storeId_paidAt_idx" ON "Order"("storeId", "paidAt");
