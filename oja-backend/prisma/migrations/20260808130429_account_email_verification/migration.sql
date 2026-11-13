-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "emailVerifiedAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "AccountVerificationToken" (
    "id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "accountId" UUID NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountVerificationToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountVerificationToken_token_key" ON "AccountVerificationToken"("token");

-- CreateIndex
CREATE INDEX "AccountVerificationToken_accountId_idx" ON "AccountVerificationToken"("accountId");

-- AddForeignKey
ALTER TABLE "AccountVerificationToken" ADD CONSTRAINT "AccountVerificationToken_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
