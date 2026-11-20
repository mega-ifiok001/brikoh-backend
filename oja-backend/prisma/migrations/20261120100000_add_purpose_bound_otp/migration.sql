-- Replace raw email verification links with short-lived OTP challenges.
-- Existing links and emailed password-reset grants must not remain valid
-- across this credential-format change.
DROP TABLE "AccountVerificationToken";
DELETE FROM "PasswordResetToken";

CREATE TYPE "OtpPurpose" AS ENUM (
  'EMAIL_VERIFICATION',
  'PASSWORD_RESET',
  'TRANSACTION_CONFIRMATION'
);

CREATE TABLE "OtpChallenge" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "purpose" "OtpPurpose" NOT NULL,
    "destination" TEXT NOT NULL,
    "codeHash" VARCHAR(64) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "invalidatedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpChallenge_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OtpChallenge_attempts_check" CHECK ("attempts" >= 0 AND "attempts" <= 5),
    CONSTRAINT "OtpChallenge_codeHash_check" CHECK (length("codeHash") = 64)
);

CREATE INDEX "OtpChallenge_accountId_purpose_destination_createdAt_idx"
    ON "OtpChallenge"("accountId", "purpose", "destination", "createdAt");
CREATE INDEX "OtpChallenge_destination_purpose_createdAt_idx"
    ON "OtpChallenge"("destination", "purpose", "createdAt");
CREATE INDEX "OtpChallenge_expiresAt_idx" ON "OtpChallenge"("expiresAt");
CREATE INDEX "OtpChallenge_active_account_purpose_idx"
    ON "OtpChallenge"("accountId", "purpose", "destination", "expiresAt")
    WHERE "usedAt" IS NULL AND "invalidatedAt" IS NULL;

ALTER TABLE "OtpChallenge"
    ADD CONSTRAINT "OtpChallenge_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
