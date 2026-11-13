-- Product-level SKU (analytics enrichment): optional, free-form,
-- indexed for import matching and search.

ALTER TABLE "Product" ADD COLUMN "sku" VARCHAR(64);

CREATE INDEX "Product_storeId_sku_idx" ON "Product"("storeId", "sku");