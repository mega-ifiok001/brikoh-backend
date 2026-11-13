import { Router } from "express";
import {
  addMessageHandler,
  createTicketHandler,
  getTicketHandler,
  listTicketsHandler,
} from "./controller.js";
export const supportRouter = Router();
supportRouter.post("/tickets", createTicketHandler);
supportRouter.get("/tickets", listTicketsHandler);
supportRouter.get("/tickets/:ticketId", getTicketHandler);
supportRouter.post("/tickets/:ticketId/messages", addMessageHandler);
