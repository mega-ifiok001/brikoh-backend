-- Merchant two-factor authentication removed: TOTP was not the right
-- credential source for merchant accounts (the admin TOTP fields on
-- AdminUser are unaffected).
ALTER TABLE "Account"
  DROP COLUMN "totpSecret",
  DROP COLUMN "totpEnabledAt";