-- CreateEnum
CREATE TYPE "SubscriptionPaymentKind" AS ENUM ('SUBSCRIPTION', 'UPGRADE', 'RENEWAL');

-- CreateEnum
CREATE TYPE "SubscriptionPaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED');

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "legacyPaystackPlanCode" TEXT,
ADD COLUMN     "legacyPaystackSubscriptionCode" TEXT,
ADD COLUMN     "pastDueAt" TIMESTAMPTZ(3),
ADD COLUMN     "paystackEmailToken" TEXT,
ADD COLUMN     "paystackPlanCode" TEXT,
ADD COLUMN     "paystackSubscriptionCode" TEXT,
ADD COLUMN     "pendingDowngradeTier" "SubscriptionTier",
ADD COLUMN     "renewalCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "swapPending" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "SubscriptionPlanSetting" ADD COLUMN     "paystackPlanCode" TEXT;

-- CreateTable
CREATE TABLE "SubscriptionPayment" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "tier" "SubscriptionTier" NOT NULL,
    "kind" "SubscriptionPaymentKind" NOT NULL,
    "status" "SubscriptionPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "reference" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "providerRef" TEXT,
    "paidAt" TIMESTAMPTZ(3),
    "externalEventId" TEXT,
    "orphanReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPayment_reference_key" ON "SubscriptionPayment"("reference");

-- CreateIndex
CREATE INDEX "SubscriptionPayment_storeId_createdAt_idx" ON "SubscriptionPayment"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "SubscriptionPayment_storeId_status_idx" ON "SubscriptionPayment"("storeId", "status");

-- AddForeignKey
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
