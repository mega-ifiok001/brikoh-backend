import { Router } from "express";
import { adminSupportRouter } from "./support/routes.js";
import { adminAnnouncementsRouter } from "./announcements/routes.js";
import { requireAdminAuth, requireAdminPermission } from "../../middleware/adminAuth.js";
import {
  auditLogHandler,
  activationHandler,
  churnHandler,
  adminLogoutHandler,
  adminRefreshHandler,
  ledgerAnomaliesHandler,
  listPricingHandler,
  loginHandler,
  meHandler,
  merchantsHandler,
  moderationQueueHandler,
  orphanedOrdersHandler,
  ordersHandler,
  overviewHandler,
  reprocessWebhookHandler,
  resetTwoFactorHandler,
  rotateTwoFactorHandler,
  searchStoresHandler,
  signupsHandler,
  storeDetailHandler,
  storesFleetHandler,
  subscriptionsHealthHandler,
  updatePricingHandler,
  telemetryFunnelHandler,
  medianTimeToFirstOrderHandler,
  awaitingPaymentOrdersHandler,
  adminStaffHandler,
} from "./controller.js";

/**
 * Admin routes. The LOGIN half is public (rate-limited at the app.ts
 * mount); everything else sits behind requireAdminAuth with per-route
 * requireAdminPermission guards. The audit-log endpoint additionally
 * enforces SUPER_ADMIN in the service, by contract.
 */

export const adminAuthRouter = Router();

adminAuthRouter.post("/login", loginHandler);
adminAuthRouter.post("/refresh", adminRefreshHandler);
adminAuthRouter.post("/logout", adminLogoutHandler);

export const adminRouter = Router();

adminRouter.use(requireAdminAuth);
adminRouter.use("/support", adminSupportRouter);
adminRouter.use("/announcements", adminAnnouncementsRouter);

adminRouter.post("/auth/2fa/rotate", rotateTwoFactorHandler);
adminRouter.post("/auth/2fa/reset", resetTwoFactorHandler);
adminRouter.get("/me", meHandler);
adminRouter.get("/audit-log", requireAdminPermission("audit:view"), auditLogHandler);

adminRouter.get("/stores/search", requireAdminPermission("stores:view"), searchStoresHandler);
adminRouter.get("/stores/:storeId", requireAdminPermission("stores:view"), storeDetailHandler);

// Cross-tenant read views — each is permission-gated and audit-logged on
// access (the new admin.*.viewed actions).
adminRouter.get("/overview", requireAdminPermission("admin:overview.view"), overviewHandler);
adminRouter.get("/merchants", requireAdminPermission("admin:merchants.view"), merchantsHandler);
adminRouter.get("/stores", requireAdminPermission("admin:stores.view"), storesFleetHandler);
adminRouter.get("/orders", requireAdminPermission("admin:orders.view"), ordersHandler);
adminRouter.get(
  "/telemetry/funnel",
  requireAdminPermission("admin:telemetry.view"),
  telemetryFunnelHandler,
);
adminRouter.get(
  "/telemetry/median-time-to-first-order",
  requireAdminPermission("admin:telemetry.view"),
  medianTimeToFirstOrderHandler,
);
adminRouter.get(
  "/payments/awaiting-confirmation",
  requireAdminPermission("admin:payments.awaiting-confirmation.view"),
  awaitingPaymentOrdersHandler,
);
adminRouter.get("/staff", requireAdminPermission("admin:staff.view"), adminStaffHandler);

adminRouter.get("/health/signups", requireAdminPermission("stores:view"), signupsHandler);
adminRouter.get("/health/activation", requireAdminPermission("stores:view"), activationHandler);
adminRouter.get(
  "/health/subscriptions",
  requireAdminPermission("stores:view"),
  subscriptionsHealthHandler,
);
adminRouter.get("/health/churn", requireAdminPermission("stores:view"), churnHandler);

adminRouter.get("/billing/pricing", requireAdminPermission("stores:view"), listPricingHandler);
adminRouter.put(
  "/billing/pricing/:plan",
  requireAdminPermission("billing:edit"),
  updatePricingHandler,
);

adminRouter.post(
  "/webhook-events/:eventId/reprocess",
  requireAdminPermission("operations:run"),
  reprocessWebhookHandler,
);

adminRouter.get(
  "/integrity/ledger-anomalies",
  requireAdminPermission("operations:run"),
  ledgerAnomaliesHandler,
);
adminRouter.get(
  "/integrity/orphaned-orders",
  requireAdminPermission("operations:run"),
  orphanedOrdersHandler,
);

adminRouter.get(
  "/moderation/flagged-content",
  requireAdminPermission("operations:run"),
  moderationQueueHandler,
);
