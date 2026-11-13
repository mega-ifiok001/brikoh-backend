-- Manual bank-transfer payment support.
-- Order gains a frozen snapshot of the merchant's bank details (mirrors
-- unitPriceAtPurchase) plus an AWAITING_PAYMENT status; BankAccount gains a
-- merchant-entered accountNumber and the Paystack-only fields become optional.

-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'AWAITING_PAYMENT';

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'PAYMENT_CLAIMED';

-- Order: bank-transfer snapshot + FK (traceability only)
ALTER TABLE "Order" ADD COLUMN "paymentSubmittedAt" TIMESTAMPTZ(3);
ALTER TABLE "Order" ADD COLUMN "bankAccountId" UUID;
ALTER TABLE "Order" ADD COLUMN "bankName" VARCHAR(2048);
ALTER TABLE "Order" ADD COLUMN "accountName" VARCHAR(2048);
ALTER TABLE "Order" ADD COLUMN "accountNumber" VARCHAR(64);

-- BankAccount: full account number for direct transfers; Paystack-only
-- fields become optional so merchant-managed accounts need none of them.
ALTER TABLE "BankAccount" ADD COLUMN "accountNumber" VARCHAR(64);
ALTER TABLE "BankAccount" ALTER COLUMN "bankCode" DROP NOT NULL;
ALTER TABLE "BankAccount" ALTER COLUMN "maskedAccountNumber" DROP NOT NULL;
ALTER TABLE "BankAccount" ALTER COLUMN "recipientCode" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_bankAccountId_fkey"
  FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Order_bankAccountId_idx" ON "Order"("bankAccountId");
