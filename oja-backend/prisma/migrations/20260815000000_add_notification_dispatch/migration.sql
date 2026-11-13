-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('LOW_STOCK', 'EXPIRING_SOON', 'PAYMENT_RECEIVED');

-- CreateTable
CREATE TABLE "NotificationDispatch" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "refType" TEXT NOT NULL,
    "refId" UUID NOT NULL,
    "sentQuantity" INTEGER,
    "snapshot" JSONB NOT NULL,
    "sentAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationDispatch_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "NotificationDispatch_storeId_kind_sentAt_idx" ON "NotificationDispatch"("storeId", "kind", "sentAt");

-- The dedup gate: at most one dispatch row per (store, kind, ref). The
-- notifications service re-alerts on WORSENING low stock by comparing the
-- existing row's sentQuantity against the current quantity and updating
-- that row when it sends again (never a second row for the same ref).
CREATE UNIQUE INDEX "NotificationDispatch_storeId_kind_refType_refId_key" ON "NotificationDispatch"("storeId", "kind", "refType", "refId");

-- Foreign keys
ALTER TABLE "NotificationDispatch" ADD CONSTRAINT "NotificationDispatch_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
