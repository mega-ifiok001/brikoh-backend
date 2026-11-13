-- Google OAuth sign-in: accounts created via "Sign in with Google" have
-- no password (email ownership is proven by Google), so passwordHash
-- becomes nullable. googleSub is Google's stable subject id for the
-- account, used to link a Google identity even if the user later changes
-- their Google email; unique so one Google account maps to one local
-- account.
ALTER TABLE "Account"
  ALTER COLUMN "passwordHash" DROP NOT NULL,
  ADD COLUMN "googleSub" TEXT;

CREATE UNIQUE INDEX "Account_googleSub_key" ON "Account"("googleSub");