-- CreateEnum
CREATE TYPE "WalletEntryType" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "WalletEntrySource" AS ENUM ('ORDER_PAYMENT', 'WITHDRAWAL', 'WITHDRAWAL_REVERSAL', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('REQUESTED', 'PROCESSING', 'SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "StoreWallet" (
    "storeId" UUID NOT NULL,
    "balance" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StoreWallet_pkey" PRIMARY KEY ("storeId")
);

-- CreateTable
CREATE TABLE "WalletEntry" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "type" "WalletEntryType" NOT NULL,
    "source" "WalletEntrySource" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "balanceAfter" DECIMAL(10,2) NOT NULL,
    "orderId" UUID,
    "payoutId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankAccount" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "accountName" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "maskedAccountNumber" TEXT NOT NULL,
    "recipientCode" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "bankAccountId" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "transferCode" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "fee" DECIMAL(10,2),
    "status" "PayoutStatus" NOT NULL DEFAULT 'REQUESTED',
    "processedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WalletEntry_storeId_idx" ON "WalletEntry"("storeId");

-- CreateIndex
CREATE INDEX "WalletEntry_storeId_createdAt_idx" ON "WalletEntry"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "WalletEntry_orderId_idx" ON "WalletEntry"("orderId");

-- CreateIndex
CREATE INDEX "WalletEntry_payoutId_idx" ON "WalletEntry"("payoutId");

-- CreateIndex
CREATE UNIQUE INDEX "BankAccount_storeId_recipientCode_key" ON "BankAccount"("storeId", "recipientCode");

-- CreateIndex
CREATE INDEX "BankAccount_storeId_idx" ON "BankAccount"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_reference_key" ON "Payout"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_transferCode_key" ON "Payout"("transferCode");

-- CreateIndex
CREATE INDEX "Payout_storeId_idx" ON "Payout"("storeId");

-- CreateIndex
CREATE INDEX "Payout_storeId_status_idx" ON "Payout"("storeId", "status");

-- CreateIndex
CREATE INDEX "Payout_bankAccountId_idx" ON "Payout"("bankAccountId");

-- AddForeignKey
ALTER TABLE "StoreWallet" ADD CONSTRAINT "StoreWallet_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletEntry" ADD CONSTRAINT "WalletEntry_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletEntry" ADD CONSTRAINT "WalletEntry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletEntry" ADD CONSTRAINT "WalletEntry_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "Payout"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The wallet ledger is append-only, mirroring stock/invoice-payment
-- discipline: a DB trigger rejects UPDATE/DELETE outside trigger context
-- (cleanup scripts run with triggers disabled).
CREATE OR REPLACE FUNCTION prevent_wallet_entry_mutation()
RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() = 0 THEN
    RAISE EXCEPTION 'WalletEntry is append-only: updates and deletes are not allowed';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER wallet_ledger_append_only
BEFORE UPDATE OR DELETE ON "WalletEntry"
FOR EACH ROW EXECUTE FUNCTION prevent_wallet_entry_mutation();

-- A wallet movement of zero (or negative) money is meaningless.
ALTER TABLE "WalletEntry"
  ADD CONSTRAINT wallet_entry_amount_positive CHECK ("amount" > 0);
