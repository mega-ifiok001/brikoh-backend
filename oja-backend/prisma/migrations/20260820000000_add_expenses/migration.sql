-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('RENT', 'TRANSPORT', 'PACKAGING', 'SALARIES', 'MARKETING', 'UTILITIES', 'OTHER');

-- CreateTable
CREATE TABLE "Expense" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "category" "ExpenseCategory" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "description" TEXT,
    "date" DATE NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "Expense_storeId_idx" ON "Expense"("storeId");
CREATE INDEX "Expense_storeId_date_idx" ON "Expense"("storeId", "date");
CREATE INDEX "Expense_storeId_category_idx" ON "Expense"("storeId", "category");

-- Foreign keys
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
