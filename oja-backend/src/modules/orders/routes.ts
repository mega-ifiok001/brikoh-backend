import { Router } from "express";
import { resolvePublicStore } from "../../middleware/resolvePublicStore.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import {
  checkoutHandler,
  confirmPaymentHandler,
  getOrderHandler,
  getPublicOrderHandler,
  listOrdersHandler,
  markPaidHandler,
  recordPosSaleHandler,
  rejectPaymentHandler,
} from "./controller.js";

const checkoutRouter: Router = Router();

// The subdomain is the tenant's public address; resolvePublicStore
// resolves it and rejects unknown subdomains before any logic runs.
checkoutRouter.post("/:subdomain", resolvePublicStore, checkoutHandler);

/**
 * Dashboard orders (mount: /api/dashboard/orders — authenticate +
 * resolveTenant + authorize("orders.manage")). POST / is the POS
 * record-sale, a money-touching write: it gets its own per-route limiter
 * (60/min, the payments baseline). Mounted BEFORE the GETs so "/" is
 * never swallowed as a :orderId.
 */
const ordersRouter: Router = Router();
ordersRouter.post("/", rateLimit({ windowMs: 60_000, max: 60 }), recordPosSaleHandler);
ordersRouter.get("/", listOrdersHandler);
ordersRouter.get("/:orderId", getOrderHandler);
// Bank-transfer confirm/reject. Awaiting-payment orders are confirmed here by
// the merchant after the customer marks the transfer paid.
ordersRouter.post("/:orderId/confirm-payment", confirmPaymentHandler);
ordersRouter.post("/:orderId/reject-payment", rejectPaymentHandler);

/**
 * Public order self-service for bank-transfer customers (mount:
 * /api/public/orders — no auth). Keyed by the order's public UUID from the
 * checkout response. Read-only status + frozen bank details, plus the
 * "I have paid" click. Rate-limited to blunt confirmation-spam.
 */
const publicOrdersRouter: Router = Router();
publicOrdersRouter.get(
  "/:orderId",
  rateLimit({ windowMs: 60_000, max: 300 }),
  getPublicOrderHandler,
);
publicOrdersRouter.post(
  "/:orderId/mark-paid",
  rateLimit({ windowMs: 60_000, max: 20 }),
  markPaidHandler,
);

export { checkoutRouter, ordersRouter, publicOrdersRouter };
