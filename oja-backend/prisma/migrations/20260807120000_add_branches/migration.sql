-- CreateTable
CREATE TABLE "Branch" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchStock" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "variantId" UUID,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "BranchStock_pkey" PRIMARY KEY ("id")
);

-- Per-branch stock can never go negative: enforced both here (DB CHECK)
-- and by the atomic conditional UPDATE in ledger.service (which also
-- guards the concurrent-over-sell case the CHECK cannot catch by itself).
ALTER TABLE "BranchStock"
  ADD CONSTRAINT "branch_stock_quantity_non_negative" CHECK ("quantity" >= 0);

-- AlterTable — new columns added NULLABLE first, backfilled below, then
-- tightened to NOT NULL once every existing row has a branch.
ALTER TABLE "Store" ADD COLUMN "defaultBranchId" UUID;
ALTER TABLE "StockLedgerEntry" ADD COLUMN "branchId" UUID;
ALTER TABLE "Order" ADD COLUMN "branchId" UUID;

-- Backfill: every existing store gets one "Main Branch" (address = the
-- store's primary location string) and becomes its own default branch.
INSERT INTO "Branch" ("id", "storeId", "name", "address", "createdAt", "updatedAt")
SELECT gen_random_uuid(), s."id", 'Main Branch', s."location", now(), now()
FROM "Store" s;

UPDATE "Store" SET "defaultBranchId" = b."id"
FROM "Branch" b
WHERE b."storeId" = "Store"."id" AND b."name" = 'Main Branch';

-- All pre-existing ledger history attaches to the store's Main Branch.
-- The append-only trigger (stock_ledger_append_only) silently cancels
-- any UPDATE that fires it, so it is disabled for this one backfill and
-- re-enabled immediately after — the migration is the trusted upgrade
-- path and the only legitimate writer of history rows.
ALTER TABLE "StockLedgerEntry" DISABLE TRIGGER stock_ledger_append_only;
UPDATE "StockLedgerEntry" e SET "branchId" = b."id"
FROM "Branch" b
WHERE b."storeId" = e."storeId" AND b."name" = 'Main Branch';
ALTER TABLE "StockLedgerEntry" ENABLE TRIGGER stock_ledger_append_only;

-- All pre-existing orders attach to the store's Main Branch (they will
-- have decremented its stock, and payment confirmation later does too).
UPDATE "Order" o SET "branchId" = b."id"
FROM "Branch" b
WHERE b."storeId" = o."storeId" AND b."name" = 'Main Branch';

-- BranchStock rows for EVERY existing product and variant (zero-stock
-- rows included — the eager-row invariant in ledger.service), each on
-- its store's Main Branch, carrying the cached quantity as the starting
-- per-branch stock.
INSERT INTO "BranchStock" ("id", "storeId", "branchId", "productId", "variantId", "quantity", "createdAt", "updatedAt")
SELECT gen_random_uuid(), p."storeId", b."id", p."id", NULL, p."quantity", now(), now()
FROM "Product" p
JOIN "Branch" b ON b."storeId" = p."storeId" AND b."name" = 'Main Branch';

INSERT INTO "BranchStock" ("id", "storeId", "branchId", "productId", "variantId", "quantity", "createdAt", "updatedAt")
SELECT gen_random_uuid(), v."storeId", b."id", v."productId", v."id", v."quantity", now(), now()
FROM "ProductVariant" v
JOIN "Branch" b ON b."storeId" = v."storeId" AND b."name" = 'Main Branch';

-- Uniqueness is now guaranteed (every store has exactly one Main Branch).
ALTER TABLE "StockLedgerEntry" ALTER COLUMN "branchId" SET NOT NULL;
ALTER TABLE "Order" ALTER COLUMN "branchId" SET NOT NULL;
ALTER TABLE "Store" ADD CONSTRAINT "Store_defaultBranchId_key" UNIQUE ("defaultBranchId");

-- Partial unique indexes: exactly one stock row per (branch, product)
-- for variant-less products, and per (branch, product, variant) for
-- named rows. WHERE-clause indexes cannot be expressed in the Prisma
-- schema, so they live here (invisible to schema drift checks, which
-- only compare declared indexes).
CREATE UNIQUE INDEX "BranchStock_variantless_key" ON "BranchStock"("branchId", "productId") WHERE "variantId" IS NULL;
CREATE UNIQUE INDEX "BranchStock_variant_key" ON "BranchStock"("branchId", "productId", "variantId") WHERE "variantId" IS NOT NULL;

-- CreateIndex
CREATE INDEX "Branch_storeId_idx" ON "Branch"("storeId");
CREATE INDEX "BranchStock_storeId_idx" ON "BranchStock"("storeId");
CREATE INDEX "BranchStock_branchId_idx" ON "BranchStock"("branchId");
CREATE INDEX "BranchStock_productId_variantId_idx" ON "BranchStock"("productId", "variantId");
CREATE INDEX "StockLedgerEntry_branchId_idx" ON "StockLedgerEntry"("branchId");
CREATE INDEX "Order_branchId_idx" ON "Order"("branchId");

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Store" ADD CONSTRAINT "Store_defaultBranchId_fkey" FOREIGN KEY ("defaultBranchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BranchStock" ADD CONSTRAINT "BranchStock_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BranchStock" ADD CONSTRAINT "BranchStock_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BranchStock" ADD CONSTRAINT "BranchStock_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BranchStock" ADD CONSTRAINT "BranchStock_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockLedgerEntry" ADD CONSTRAINT "StockLedgerEntry_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
