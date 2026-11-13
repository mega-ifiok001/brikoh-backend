import { AppError } from "../../lib/AppError.js";
import { getPrismaClient } from "../../lib/prisma.js";
import type { TicketPriority, TicketStatus } from "../../../generated/prisma/client.js";

const include = { assignedAdmin: { select: { id: true, email: true } } };
const notFound = () => new AppError(404, "TICKET_NOT_FOUND", "Support ticket not found");

export async function createTicket(
  storeId: string,
  accountId: string,
  input: { subject: string; priority: TicketPriority; message: string },
) {
  const prisma = getPrismaClient();
  return prisma.supportTicket.create({
    data: {
      storeId,
      subject: input.subject,
      priority: input.priority,
      raisedByAccountId: accountId,
      messages: {
        create: { authorType: "MERCHANT", authorAccountId: accountId, body: input.message },
      },
    },
    include,
  });
}
export async function listTickets(
  storeId: string,
  query: { status?: TicketStatus; priority?: TicketPriority; cursor?: string; limit: number },
) {
  const rows = await getPrismaClient().supportTicket.findMany({
    where: {
      storeId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    include,
  });
  return {
    items: rows.slice(0, query.limit),
    nextCursor: rows.length > query.limit ? (rows[query.limit]?.id ?? null) : null,
  };
}
export async function getTicket(storeId: string, ticketId: string, cursor?: string, limit = 50) {
  const ticket = await getPrismaClient().supportTicket.findFirst({
    where: { id: ticketId, storeId },
    include,
  });
  if (!ticket) throw notFound();
  const rows = await getPrismaClient().ticketMessage.findMany({
    where: { ticketId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      authorAccount: { select: { id: true, email: true } },
      authorAdmin: { select: { id: true, email: true } },
    },
  });
  return {
    ticket,
    messages: rows.slice(0, limit),
    nextMessageCursor: rows.length > limit ? (rows[limit]?.id ?? null) : null,
  };
}
export async function addMerchantMessage(
  storeId: string,
  ticketId: string,
  accountId: string,
  body: string,
) {
  const ticket = await getPrismaClient().supportTicket.findFirst({
    where: { id: ticketId, storeId },
    select: { status: true },
  });
  if (!ticket) throw notFound();
  if (ticket.status === "CLOSED")
    throw new AppError(409, "TICKET_CLOSED", "Closed tickets cannot receive messages");
  return getPrismaClient().ticketMessage.create({
    data: { ticketId, authorType: "MERCHANT", authorAccountId: accountId, body },
    include: { authorAccount: { select: { id: true, email: true } } },
  });
}
