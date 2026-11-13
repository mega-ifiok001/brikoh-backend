-- CreateEnum
CREATE TYPE "ProductImportStatus" AS ENUM ('PENDING', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "ProductImportRowStatus" AS ENUM ('NEW', 'DUPLICATE', 'ERROR');

-- CreateTable
CREATE TABLE "ProductImport" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "createdByStaffId" UUID,
    "status" "ProductImportStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "confirmedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ProductImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductImportRow" (
    "id" UUID NOT NULL,
    "importId" UUID NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "name" TEXT,
    "price" DECIMAL(10,2),
    "costPrice" DECIMAL(10,2),
    "description" TEXT,
    "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "coverImageUrl" VARCHAR(2048),
    "categoryId" UUID,
    "unitId" UUID,
    "initialStock" INTEGER,
    "status" "ProductImportRowStatus" NOT NULL DEFAULT 'NEW',
    "errors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "existingProductId" UUID,
    "createdProductId" UUID,
    "overwrite" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ProductImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductImport_storeId_createdAt_idx" ON "ProductImport"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "ProductImportRow_importId_idx" ON "ProductImportRow"("importId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductImportRow_importId_rowNumber_key" ON "ProductImportRow"("importId", "rowNumber");

-- AddForeignKey
ALTER TABLE "ProductImport" ADD CONSTRAINT "ProductImport_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImport" ADD CONSTRAINT "ProductImport_createdByStaffId_fkey" FOREIGN KEY ("createdByStaffId") REFERENCES "StaffMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImportRow" ADD CONSTRAINT "ProductImportRow_importId_fkey" FOREIGN KEY ("importId") REFERENCES "ProductImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
