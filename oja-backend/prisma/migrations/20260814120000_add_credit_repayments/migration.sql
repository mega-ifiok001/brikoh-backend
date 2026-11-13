-- CreateTable
CREATE TABLE "CreditRepayment" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "note" TEXT,
    "recordedByStaffId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditRepayment_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "CreditRepayment_storeId_idx" ON "CreditRepayment"("storeId");
CREATE INDEX "CreditRepayment_orderId_idx" ON "CreditRepayment"("orderId");
CREATE INDEX "CreditRepayment_storeId_createdAt_idx" ON "CreditRepayment"("storeId", "createdAt");

-- Foreign keys
ALTER TABLE "CreditRepayment" ADD CONSTRAINT "CreditRepayment_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreditRepayment" ADD CONSTRAINT "CreditRepayment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreditRepayment" ADD CONSTRAINT "CreditRepayment_recordedByStaffId_fkey" FOREIGN KEY ("recordedByStaffId") REFERENCES "StaffMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- Data-integrity enforcement that Prisma cannot express in the schema.
-- Same discipline as StockLedgerEntry (see init_core_schema): CreditRepayment
-- is append-only financial history — inserts allowed, updates/deletes
-- rejected. pg_trigger_depth() > 0 lets cascades from the tenant root pass
-- (deleting a Store wipes its tenant data by design) while blocking direct
-- UPDATE/DELETE of repayment rows.
-- ============================================================================
CREATE OR REPLACE FUNCTION prevent_credit_repayment_mutation()
RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() = 0 THEN
    RAISE EXCEPTION 'CreditRepayment is append-only: updates and deletes are not allowed';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER credit_repayment_append_only
BEFORE UPDATE OR DELETE ON "CreditRepayment"
FOR EACH ROW EXECUTE FUNCTION prevent_credit_repayment_mutation();

-- A repayment of zero (or negative) money is meaningless.
ALTER TABLE "CreditRepayment"
  ADD CONSTRAINT credit_repayment_amount_positive CHECK ("amount" > 0);