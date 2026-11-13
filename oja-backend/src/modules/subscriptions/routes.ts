import { Router } from "express";
import { rateLimit } from "../../middleware/rateLimit.js";
import {
  cancelHandler,
  checkoutHandler,
  downgradeHandler,
  downgradePreviewHandler,
  getPaymentHandler,
  getPlanHandler,
  getUsageHandler,
  listPaymentsHandler,
  setCustomDomainHandler,
  upgradeHandler,
} from "./controller.js";

const subscriptionsRouter: Router = Router();

// Reads are not rate-limited (owner-only, cheap).
subscriptionsRouter.get("/usage", getUsageHandler);
subscriptionsRouter.get("/plan", getPlanHandler);
subscriptionsRouter.get("/payments", listPaymentsHandler);
subscriptionsRouter.get("/payments/:paymentId", getPaymentHandler);
subscriptionsRouter.get("/downgrade/preview", downgradePreviewHandler);

// Money-touching writes get the payments baseline limiter (60/min).
subscriptionsRouter.put(
  "/custom-domain",
  rateLimit({ windowMs: 60_000, max: 60 }),
  setCustomDomainHandler,
);
subscriptionsRouter.post(
  "/checkout",
  rateLimit({ windowMs: 60_000, max: 60 }),
  checkoutHandler,
);
subscriptionsRouter.post(
  "/upgrade",
  rateLimit({ windowMs: 60_000, max: 60 }),
  upgradeHandler,
);
subscriptionsRouter.post(
  "/downgrade",
  rateLimit({ windowMs: 60_000, max: 60 }),
  downgradeHandler,
);
subscriptionsRouter.post(
  "/cancel",
  rateLimit({ windowMs: 60_000, max: 60 }),
  cancelHandler,
);

export { subscriptionsRouter };
