import { Router } from "express";
import { rateLimit } from "../../middleware/rateLimit.js";
import {
  cancelPurchaseOrderHandler,
  createPurchaseOrderHandler,
  deletePurchaseOrderHandler,
  getPurchaseOrderHandler,
  issuePurchaseOrderHandler,
  listPurchaseOrdersHandler,
  receivePurchaseOrderHandler,
  recordPurchaseOrderPaymentHandler,
  updatePurchaseOrderHandler,
} from "./controller.js";

/**
 * Purchase orders (mount: /api/dashboard/purchase-orders — authenticate
 * + resolveTenant + authorize("purchases.manage")). Writes and the
 * money/stock-touching transitions get the payments baseline limiter
 * (60/min). Route order matters: the fixed "issue", "receive",
 * "payments", and "cancel" segments are declared BEFORE the
 * ":purchaseOrderId" wildcard so they are never swallowed as an id.
 */
const purchaseOrdersRouter: Router = Router();
purchaseOrdersRouter.post(
  "/:purchaseOrderId/issue",
  rateLimit({ windowMs: 60_000, max: 60 }),
  issuePurchaseOrderHandler,
);
purchaseOrdersRouter.post(
  "/:purchaseOrderId/receive",
  rateLimit({ windowMs: 60_000, max: 60 }),
  receivePurchaseOrderHandler,
);
purchaseOrdersRouter.post(
  "/:purchaseOrderId/payments",
  rateLimit({ windowMs: 60_000, max: 60 }),
  recordPurchaseOrderPaymentHandler,
);
purchaseOrdersRouter.post(
  "/:purchaseOrderId/cancel",
  rateLimit({ windowMs: 60_000, max: 60 }),
  cancelPurchaseOrderHandler,
);
purchaseOrdersRouter.get("/", listPurchaseOrdersHandler);
purchaseOrdersRouter.post(
  "/",
  rateLimit({ windowMs: 60_000, max: 60 }),
  createPurchaseOrderHandler,
);
purchaseOrdersRouter.get("/:purchaseOrderId", getPurchaseOrderHandler);
purchaseOrdersRouter.put(
  "/:purchaseOrderId",
  rateLimit({ windowMs: 60_000, max: 60 }),
  updatePurchaseOrderHandler,
);
purchaseOrdersRouter.delete(
  "/:purchaseOrderId",
  rateLimit({ windowMs: 60_000, max: 60 }),
  deletePurchaseOrderHandler,
);

export { purchaseOrdersRouter };
