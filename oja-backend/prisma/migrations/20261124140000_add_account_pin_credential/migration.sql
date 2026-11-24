CREATE TABLE "AccountPinCredential" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "pinHash" TEXT NOT NULL,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AccountPinCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccountPinCredential_accountId_key" ON "AccountPinCredential"("accountId");
ALTER TABLE "AccountPinCredential" ADD CONSTRAINT "AccountPinCredential_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
