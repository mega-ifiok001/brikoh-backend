-- AlterTable (Store gains the storefront presentation settings)
ALTER TABLE "Store"
  ADD COLUMN "storefrontSettings" JSONB;
