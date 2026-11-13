-- Merchant two-factor authentication (TOTP): pending secret + enabled stamp.
ALTER TABLE "Account"
  ADD COLUMN "totpSecret" VARCHAR(64),
  ADD COLUMN "totpEnabledAt" TIMESTAMPTZ(3);