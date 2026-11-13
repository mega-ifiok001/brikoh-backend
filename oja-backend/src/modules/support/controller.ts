import type { NextFunction, Request, Response } from "express";
import { AppError } from "../../lib/AppError.js";
import { validateOrThrow } from "../../lib/validate.js";
import { createTicketSchema, messageSchema, ticketQuerySchema } from "./schemas.js";
import { addMerchantMessage, createTicket, getTicket, listTickets } from "./service.js";
function context(req: Request) {
  if (!req.tenant || !req.account)
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  return { storeId: req.tenant.storeId, accountId: req.account.accountId };
}
function id(req: Request) {
  const value = req.params.ticketId;
  if (typeof value !== "string" || value === "")
    throw new AppError(400, "VALIDATION_ERROR", "ticketId is required");
  return value;
}
export async function createTicketHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const c = context(req);
    res.status(201).json({
      ticket: await createTicket(
        c.storeId,
        c.accountId,
        validateOrThrow(createTicketSchema, req.body),
      ),
    });
  } catch (e) {
    next(e);
  }
}
export async function listTicketsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(
      await listTickets(context(req).storeId, validateOrThrow(ticketQuerySchema, req.query)),
    );
  } catch (e) {
    next(e);
  }
}
export async function getTicketHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const q = validateOrThrow(ticketQuerySchema, req.query);
    res.json(await getTicket(context(req).storeId, id(req), q.cursor, q.limit));
  } catch (e) {
    next(e);
  }
}
export async function addMessageHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const c = context(req);
    res.status(201).json({
      message: await addMerchantMessage(
        c.storeId,
        id(req),
        c.accountId,
        validateOrThrow(messageSchema, req.body).body,
      ),
    });
  } catch (e) {
    next(e);
  }
}
