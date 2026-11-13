-- Subscription billing-period start so the rolling orderCap window is exact.
-- Nullable: pre-existing rows fall back to (currentPeriodEnd - interval '30 days')
-- at read time until they are re-provisioned with a currentPeriodStart.
ALTER TABLE "Subscription" ADD COLUMN "currentPeriodStart" timestamptz(3);

-- Optional custom domain gated by tier feature flags. Null = oja subdomain hosting.
-- UNIQUE constraint is safe even over existing rows: every row currently has
-- customDomain = NULL, and NULL < > NULL in Postgres unique indexes (distinct).
ALTER TABLE "Store" ADD COLUMN "customDomain" varchar(255);
CREATE UNIQUE INDEX "Store_customDomain_key" ON "Store" ("customDomain") WHERE "customDomain" IS NOT NULL;
