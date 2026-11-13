CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');
CREATE TYPE "TicketAuthorType" AS ENUM ('MERCHANT', 'ADMIN');
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'SUPPORT_REPLY';

CREATE TABLE "SupportTicket" (
  "id" UUID NOT NULL, "storeId" UUID NOT NULL, "subject" TEXT NOT NULL,
  "priority" "TicketPriority" NOT NULL DEFAULT 'MEDIUM', "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
  "raisedByAccountId" UUID, "assignedAdminId" UUID, "resolvedAt" TIMESTAMPTZ(3), "closedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportTicket_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SupportTicket_raisedByAccountId_fkey" FOREIGN KEY ("raisedByAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "SupportTicket_assignedAdminId_fkey" FOREIGN KEY ("assignedAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "SupportTicket_storeId_status_createdAt_idx" ON "SupportTicket"("storeId", "status", "createdAt");
CREATE INDEX "SupportTicket_assignedAdminId_status_createdAt_idx" ON "SupportTicket"("assignedAdminId", "status", "createdAt");

CREATE TABLE "TicketMessage" (
  "id" UUID NOT NULL, "ticketId" UUID NOT NULL, "authorType" "TicketAuthorType" NOT NULL,
  "authorAccountId" UUID, "authorAdminId" UUID, "body" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TicketMessage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TicketMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TicketMessage_authorAccountId_fkey" FOREIGN KEY ("authorAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "TicketMessage_authorAdminId_fkey" FOREIGN KEY ("authorAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "TicketMessage_typed_author_check" CHECK (("authorType" = 'MERCHANT' AND "authorAccountId" IS NOT NULL AND "authorAdminId" IS NULL) OR ("authorType" = 'ADMIN' AND "authorAdminId" IS NOT NULL AND "authorAccountId" IS NULL))
);
CREATE INDEX "TicketMessage_ticketId_createdAt_id_idx" ON "TicketMessage"("ticketId", "createdAt", "id");
