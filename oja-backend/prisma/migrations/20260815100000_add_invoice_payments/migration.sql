-- AlterTable (Invoice gains settlement fields)
ALTER TABLE "Invoice"
  ADD COLUMN "number" TEXT,
  ADD COLUMN "amountPaid" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "dueDate" TIMESTAMPTZ(3),
  ADD COLUMN "issuedAt" TIMESTAMPTZ(3);

-- AlterTable (Store gains the invoice-numbering counter)
ALTER TABLE "Store"
  ADD COLUMN "invoiceCounter" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Invoice_storeId_customerId_idx" ON "Invoice"("storeId", "customerId");
CREATE INDEX "Invoice_storeId_status_idx" ON "Invoice"("storeId", "status");

-- CreateTable
CREATE TABLE "InvoicePayment" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "note" TEXT,
    "recordedByStaffId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoicePayment_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "InvoicePayment_storeId_idx" ON "InvoicePayment"("storeId");
CREATE INDEX "InvoicePayment_invoiceId_idx" ON "InvoicePayment"("invoiceId");
CREATE INDEX "InvoicePayment_storeId_createdAt_idx" ON "InvoicePayment"("storeId", "createdAt");

-- Foreign keys
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_recordedByStaffId_fkey" FOREIGN KEY ("recordedByStaffId") REFERENCES "StaffMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- Data-integrity enforcement that Prisma cannot express in the schema.
-- Same discipline as CreditRepayment and StockLedgerEntry: InvoicePayment
-- is append-only financial history — inserts allowed, updates/deletes
-- rejected. pg_trigger_depth() > 0 lets cascades from the tenant root pass
-- (deleting a Store wipes its tenant data by design) while blocking direct
-- UPDATE/DELETE of payment rows.
-- ============================================================================
CREATE OR REPLACE FUNCTION prevent_invoice_payment_mutation()
RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() = 0 THEN
    RAISE EXCEPTION 'InvoicePayment is append-only: updates and deletes are not allowed';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoice_payment_append_only
BEFORE UPDATE OR DELETE ON "InvoicePayment"
FOR EACH ROW EXECUTE FUNCTION prevent_invoice_payment_mutation();

-- A payment of zero (or negative) money is meaningless.
ALTER TABLE "InvoicePayment"
  ADD CONSTRAINT invoice_payment_amount_positive CHECK ("amount" > 0);
