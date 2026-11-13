/*
  Warnings:

  - A unique constraint covering the columns `[storeId,paymentReference]` on the table `Order` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "authorizationUrl" TEXT,
ADD COLUMN     "paymentProvider" TEXT,
ADD COLUMN     "paymentReference" TEXT;

-- CreateTable
CREATE TABLE "PaymentCredential" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "secretKeyEncrypted" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PaymentCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentCredential_storeId_idx" ON "PaymentCredential"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentCredential_storeId_provider_key" ON "PaymentCredential"("storeId", "provider");

-- CreateIndex
CREATE INDEX "Order_storeId_status_idx" ON "Order"("storeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Order_storeId_paymentReference_key" ON "Order"("storeId", "paymentReference");

-- AddForeignKey
ALTER TABLE "PaymentCredential" ADD CONSTRAINT "PaymentCredential_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
