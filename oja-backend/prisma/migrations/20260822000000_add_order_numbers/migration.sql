-- Store-sequential order numbers (ORD-####).
-- 1) counter column on Store (same atomic pattern as invoices/POs)
-- 2) orderNumber on Order, backfilled in createdAt order, then NOT NULL
--    + unique per store.

ALTER TABLE "Store" ADD COLUMN "orderCounter" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Order" ADD COLUMN "orderNumber" VARCHAR(16);

-- Deterministic backfill: per store, in (createdAt, id) order.
UPDATE "Order" o
SET "orderNumber" = 'ORD-' || LPAD(seq.rn::text, 4, '0')
FROM (
  SELECT
    id,
    ROW_NUMBER() OVER (PARTITION BY "storeId" ORDER BY "createdAt", "id") AS rn
  FROM "Order"
) seq
WHERE o.id = seq.id;

ALTER TABLE "Order" ALTER COLUMN "orderNumber" SET NOT NULL;

-- Unique per store (and implicitly NOT NULL from above).
CREATE UNIQUE INDEX "Order_storeId_orderNumber_key" ON "Order"("storeId", "orderNumber");
