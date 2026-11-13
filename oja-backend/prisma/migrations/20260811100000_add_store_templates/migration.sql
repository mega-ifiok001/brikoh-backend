-- CreateTable
CREATE TABLE "StoreTemplate" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "previewUrl" VARCHAR(2048),
    "sortOrder" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StoreTemplate_pkey" PRIMARY KEY ("id")
);

-- Seed the dev-controlled catalog. Fixed IDs so seed.ts upserts stay
-- idempotent. sortOrder IS the visibility ordering: the tier count cut
-- (templateCap: STARTER 3, PRO 5, ENTERPRISE all) slices this order, so
-- the first three rows are exactly what STARTER sees.
INSERT INTO "StoreTemplate" ("id", "slug", "name", "description", "previewUrl", "sortOrder", "isActive", "createdAt", "updatedAt") VALUES
  ('019FC8C4-5A01-7001-8001-000000000001', 'market',   'Market Classic', 'Simple single-column storefront', NULL, 1, true, now(), now()),
  ('019FC8C4-5A01-7001-8001-000000000002', 'boutique', 'Boutique Chic', 'Image-forward product cards', NULL, 2, true, now(), now()),
  ('019FC8C4-5A01-7001-8001-000000000003', 'minimal',  'Minimal Clean', 'Text-focused, whitespace-heavy layout', NULL, 3, true, now(), now()),
  ('019FC8C4-5A01-7001-8001-000000000004', 'urban',    'Urban Edge', 'Bold typography with dark accents', NULL, 4, true, now(), now()),
  ('019FC8C4-5A01-7001-8001-000000000005', 'fresh',    'Fresh Grocer', 'Produce-market layout', NULL, 5, true, now(), now()),
  ('019FC8C4-5A01-7001-8001-000000000006', 'luxe',     'Luxe Noir', 'Premium fashion presentation', NULL, 6, true, now(), now()),
  ('019FC8C4-5A01-7001-8001-000000000007', 'festive',  'Festival Pop', 'Seasonal, playful storefront', NULL, 7, true, now(), now()),
  ('019FC8C4-5A01-7001-8001-000000000008', 'glass',    'Glass Showcase', 'Gallery grid layout', NULL, 8, true, now(), now());

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "templateId" UUID;
ALTER TABLE "Subscription" ADD COLUMN     "templateCap" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "StoreTemplate_slug_key" ON "StoreTemplate"("slug");
CREATE INDEX "StoreTemplate_sortOrder_idx" ON "StoreTemplate"("sortOrder");
CREATE INDEX "Store_templateId_idx" ON "Store"("templateId");

-- AddForeignKey
ALTER TABLE "Store" ADD CONSTRAINT "Store_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "StoreTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
