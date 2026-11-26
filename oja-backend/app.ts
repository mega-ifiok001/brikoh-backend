/**
 * ============================================================
 * BRIKOH — TRUST SURFACE MAP
 * ============================================================
 * This file is the single map of the API's trust boundaries.
 * Route groups are the trust boundary of the whole API:
 *
 *   /api/public/*    -> no auth. Never mounts tenant-scoped data here.
 *   /api/dashboard/* -> authenticate + authorize + resolveTenant
 *   /api/webhooks/*  -> merchant-verifiable webhooks (no JWTs)
 *   /api/admin/*     -> authenticate + authorize (platform staff)
 *
 * Every module router must be mounted under exactly one group with an
 * explicit, deliberate line below. Do not mount routers ad hoc, and do
 * not add middleware stacks inline here — use src/middleware/.
 *
 * The global error handler is mounted LAST and is the only place that
 * formats error responses.
 * ============================================================
 */
import express, { type Express } from "express";
import helmet from "helmet";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import { env } from "./src/config/env.js";
import { AppError } from "./src/lib/AppError.js";
import { isAllowedCorsOrigin } from "./src/lib/cors.js";
import { errorHandler } from "./src/middleware/errorHandler.js";
import { requestLogger } from "./src/middleware/logger.js";
import { authenticate } from "./src/middleware/authenticate.js";
import { authorize } from "./src/middleware/authorize.js";
import { resolveTenant } from "./src/middleware/resolveTenant.js";
import { rateLimit } from "./src/middleware/rateLimit.js";
import { healthRouter } from "./src/modules/health/routes.js";
import {
  authRouter,
  dashboardAccountRouter,
  dashboardMeRouter,
  dashboardPasswordRouter,
  onboardingRouter,
  resendVerificationRouter,
} from "./src/modules/auth/routes.js";
import { productsRouter } from "./src/modules/products/routes.js";
import { uploadsRouter } from "./src/modules/uploads/routes.js";
import { locationsRouter } from "./src/modules/locations/routes.js";
import { invitePublicRouter, staffRouter } from "./src/modules/staff/routes.js";
import { requireOwner } from "./src/middleware/requireOwner.js";
import { paymentsRouter } from "./src/modules/payments/routes.js";
import { walletRouter } from "./src/modules/wallet/routes.js";
import { checkoutRouter, ordersRouter, publicOrdersRouter } from "./src/modules/orders/routes.js";
import { webhooksRouter } from "./src/modules/webhooks/routes.js";
import { subscriptionsRouter } from "./src/modules/subscriptions/routes.js";
import { analyticsRouter } from "./src/modules/analytics/routes.js";
import { reportsRouter } from "./src/modules/reports/routes.js";
import { expensesRouter } from "./src/modules/expenses/routes.js";
import { campaignsRouter } from "./src/modules/campaigns/routes.js";
import { adminAuthRouter, adminRouter } from "./src/modules/admin/routes.js";
import { activityRouter } from "./src/modules/activity/routes.js";
import { categoriesRouter, unitsRouter } from "./src/modules/catalog/routes.js";
import { branchTransfersRouter, branchesRouter } from "./src/modules/branches/routes.js";
import { templatesCatalogRouter, templatesSettingsRouter } from "./src/modules/templates/routes.js";
import { overviewRouter } from "./src/modules/overview/routes.js";
import { settingsRouter } from "./src/modules/settings/routes.js";
import { customersRouter } from "./src/modules/customers/routes.js";
import { customerGroupsRouter } from "./src/modules/customer-groups/routes.js";
import { discountsRouter } from "./src/modules/discounts/routes.js";
import { invoicesRouter, publicInvoicesRouter } from "./src/modules/invoices/routes.js";
import { notificationsRouter } from "./src/modules/notifications/routes.js";
import {
  storefrontPublicRouter,
  storefrontSettingsRouter,
} from "./src/modules/storefront/routes.js";
import { suppliersRouter } from "./src/modules/suppliers/routes.js";
import { purchaseOrdersRouter } from "./src/modules/purchase-orders/routes.js";
import { supportRouter } from "./src/modules/support/routes.js";
import { announcementsRouter } from "./src/modules/announcements/routes.js";

export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");

  // Trust the first reverse-proxy hop (see env.TRUST_PROXY) so req.ip —
  // and the IP-keyed rate limiter — sees the real client address.
  app.set("trust proxy", env.TRUST_PROXY ? 1 : false);

  // Helmet: defense-in-depth HTTP headers. Content-Security-Policy is
  // deliberately disabled: this API serves JSON only, never HTML, so a
  // CSP header would imply a protection that cannot apply to JSON
  // responses. Every other Helmet default (X-Frame-Options, nosniff,
  // HSTS, …) stays active; HSTS additionally covers sibling subdomains.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
    }),
  );

  // CORS: allow only origins derived from FRONTEND_URL (the exact origin
  // plus sibling subdomains of its apex, for dynamically-created merchant
  // storefronts) and localhost dev ports. The allowed origin is reflected
  // per request — never a wildcard "*" — so credential-carrying requests
  // cannot be silently broken. No cookies exist in this API (bearer JWTs
  // only), so no credentials flag is needed.
  app.use(
    cors({
      origin: (origin, callback) => {
        void origin;
        callback(null, isAllowedCorsOrigin(origin ?? undefined));
      },
    }),
  );

  app.use(requestLogger);

  // Interactive OpenAPI reference for authentication and payments. The UI
  // assets are served locally by swagger-ui-express; only the specs are static.
  app.use("/api-docs/openapi", express.static("public/openapi", { fallthrough: false }));
  app.use(
    "/api-docs",
    swaggerUi.serve,
    swaggerUi.setup(undefined, {
      // swagger-ui-express hides the URL selector unless explorer mode is on.
      explorer: true,
      swaggerOptions: {
        urls: [
          { url: "/api-docs/openapi/auth.yaml", name: "Authentication" },
          { url: "/api-docs/openapi/users.yaml", name: "Users" },
          { url: "/api-docs/openapi/payments.yaml", name: "Payments" },
        ],
        "urls.primaryName": "Authentication",
        persistAuthorization: false,
      },
    }),
  );

  // Sensitive authenticated surfaces must never be cached by a shared
  // proxy or the browser back/forward cache. Applied early, before any
  // dashboard/admin route, so every response under these prefixes is
  // stamped no-store regardless of the handler.
  app.use(["/api/dashboard", "/api/admin"], (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  // The verify hook captures the EXACT bytes of every request body into
  // req.rawBody — webhook handlers verify provider signatures over these
  // bytes, never over a re-serialized body. The hook's req is typed as
  // IncomingMessage; the Express.Request augmentation covers it.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = buf;
      },
    }),
  );

  // Simple public root endpoint for deployment/platform checks.
  app.get("/", (_req, res) => {
    res.status(200).json({
      status: "ok",
      message: "Brikoh API is running",
      docs: "/api-docs",
    });
  });

  // --- public group -----------------------------------------------------
  // No auth. Only non-tenant-scoped, intentionally public endpoints.
  // Health gets a limiter too: it is the cheapest endpoint to hammer and
  // must not become a free way to saturate the process.
  app.use("/api/public/health", rateLimit({ windowMs: 60_000, max: 300 }), healthRouter);
  // Auth endpoints are rate-limited as a whole group (RULES.md security
  // baseline). Fixed-window in-memory limiter — a shared store replaces
  // it once the deployment is horizontally scaled.
  app.use("/api/public/auth", rateLimit({ windowMs: 60_000, max: 300 }), authRouter);
  // The accept-invite half of the staff invite lifecycle: the invite
  // token is the credential, so it lives in the public auth group and is
  // rate-limited like the rest of the credential endpoints.
  app.use("/api/public/auth", rateLimit({ windowMs: 60_000, max: 300 }), invitePublicRouter);
  // Public checkout: subdomain-addressed, touches payment data, so it
  // is rate-limited as a group (RULES.md security baseline).
  app.use("/api/public/checkout", rateLimit({ windowMs: 60_000, max: 300 }), checkoutRouter);
  // Public storefront read: what the storefront page renders (template,
  // hero copy, accent, WhatsApp button, social links). Subdomain-
  // addressed like checkout; the projection is deliberately narrow (name
  // + settings, never tenant data).
  app.use(
    "/api/public/storefront",
    rateLimit({ windowMs: 60_000, max: 300 }),
    storefrontPublicRouter,
  );
  // Public order status + bank-transfer "I have paid" (keyed by order UUID).
  // No auth: the customer only ever holds the order id from checkout.
  app.use("/api/public/orders", rateLimit({ windowMs: 60_000, max: 300 }), publicOrdersRouter);
  // Public invoice link (customers who hold the merchant's shared link).
  // Read-only projection; the merchant records payment on their side.
  // Rate-limited to blunt link-harvesting.
  app.use("/api/public/invoices", rateLimit({ windowMs: 60_000, max: 300 }), publicInvoicesRouter);

  // --- dashboard group ---------------------------------------------------
  // authenticate + resolveTenant; authorize(permission) is mounted
  // per-route on top of this stack.
  // /me, /resend-verification, and /onboarding run authenticate only:
  // /me must answer a fresh (tenant-less) account with needsOnboarding
  // instead of a 401, /resend-verification serves the pre-onboarding
  // verification step, and /onboarding is exactly the step that creates
  // the tenant.
  app.use("/api/dashboard/me", authenticate, dashboardMeRouter);
  // Password change and account deletion are authenticate-only (like /me):
  // both must work for pre-onboarding accounts and neither needs tenant
  // context. Both are rate-limited — the password endpoint as a
  // credential endpoint, account deletion because it tears down a tenant.
  app.use(
    "/api/dashboard/settings/password",
    authenticate,
    rateLimit({ windowMs: 60_000, max: 300 }),
    dashboardPasswordRouter,
  );
  app.use(
    "/api/dashboard/account",
    authenticate,
    rateLimit({ windowMs: 60_000, max: 300 }),
    dashboardAccountRouter,
  );
  app.use(
    "/api/dashboard/resend-verification",
    authenticate,
    rateLimit({ windowMs: 60_000, max: 300 }),
    resendVerificationRouter,
  );
  app.use(
    "/api/dashboard/onboarding",
    authenticate,
    rateLimit({ windowMs: 60_000, max: 300 }),
    onboardingRouter,
  );
  app.use(
    "/api/dashboard/products",
    authenticate,
    resolveTenant,
    authorize("products.manage"),
    productsRouter,
  );
  // Presigned image uploads are product assets, hence the same permission.
  app.use(
    "/api/dashboard/uploads",
    authenticate,
    resolveTenant,
    authorize("products.manage"),
    uploadsRouter,
  );
  // Storefront locations are tenant resources staff may manage with the
  // explicit locations.manage permission (owners pass implicitly).
  app.use(
    "/api/dashboard/locations",
    authenticate,
    resolveTenant,
    authorize("locations.manage"),
    locationsRouter,
  );
  // Branches: physical points where stock sits. CRUD and default-branch
  // management are tenant structure (locations.manage); the transfer
  // route is a stock movement (products.manage, same trust as
  // stock-adjustments) and is mounted FIRST so "transfers" is never
  // swallowed as a branch id.
  app.use(
    "/api/dashboard/branches",
    authenticate,
    resolveTenant,
    authorize("products.manage"),
    branchTransfersRouter,
  );
  app.use(
    "/api/dashboard/branches",
    authenticate,
    resolveTenant,
    authorize("locations.manage"),
    branchesRouter,
  );
  // Catalog taxonomy (categories + units): tenant resources managed with
  // the explicit catalog.manage permission; owners pass implicitly.
  app.use(
    "/api/dashboard/categories",
    authenticate,
    resolveTenant,
    authorize("catalog.manage"),
    categoriesRouter,
  );
  app.use(
    "/api/dashboard/units",
    authenticate,
    resolveTenant,
    authorize("catalog.manage"),
    unitsRouter,
  );
  // Dashboard orders: POS record-sale (POST) + read-only list/detail.
  // Sales recording carries the orders.manage trust level — the same
  // permission the staff performance / order analytics rely on; the
  // write half is rate-limited inside the router (money-touching).
  app.use(
    "/api/dashboard/orders",
    authenticate,
    resolveTenant,
    authorize("orders.manage"),
    ordersRouter,
  );
  // Staff management is a tenant-root privilege: requireOwner rejects
  // every staff role, staff.manage permission included.
  app.use("/api/dashboard/staff", authenticate, resolveTenant, requireOwner, staffRouter);
  // The store activity log is a tenant-root resource: it can expose who
  // did what across the whole store, so only the owner may read it.
  app.use("/api/dashboard/activity", authenticate, resolveTenant, requireOwner, activityRouter);
  app.use("/api/dashboard/support", authenticate, resolveTenant, requireOwner, supportRouter);
  app.use("/api/dashboard/announcements", authenticate, resolveTenant, announcementsRouter);
  // Payment credentials are merchant (owner) settings: the same
  // requireOwner trust level as staff management, rate-limited because
  // the endpoint touches payment data.
  app.use(
    "/api/dashboard/payments",
    authenticate,
    resolveTenant,
    requireOwner,
    rateLimit({ windowMs: 60_000, max: 300 }),
    paymentsRouter,
  );
  // The store wallet is merchant money: owner-only, like payment
  // credentials, and rate-limited for the same reason.
  app.use(
    "/api/dashboard/wallet",
    authenticate,
    resolveTenant,
    requireOwner,
    rateLimit({ windowMs: 60_000, max: 300 }),
    walletRouter,
  );

  // --- webhooks group ----------------------------------------------------
  // Merchant-verifiable webhooks: the provider signature header is the
  // credential (no JWTs). Rate-limited because it touches payment data.
  app.use("/api/webhooks", rateLimit({ windowMs: 60_000, max: 300 }), webhooksRouter);

  // --- subscriptions group (dashboard) -----------------------------------
  // Owner-only: plan/usage are merchant settings; custom-domain writes are
  // feature-gated in the service (PLAN_FEATURE_LOCKED), not by permission
  // flags. Same trust level as staff and payments.
  app.use(
    "/api/dashboard/subscriptions",
    authenticate,
    resolveTenant,
    requireOwner,
    subscriptionsRouter,
  );

  // Dashboard analytics: read-only reporting over the tenant's own sales
  // data. Staff need the explicit analytics.manage permission; tier gating
  // (advancedAnalytics flag) is enforced in the analytics service.
  app.use(
    "/api/dashboard/analytics",
    authenticate,
    resolveTenant,
    authorize("analytics.manage"),
    analyticsRouter,
  );

  // Dashboard reports: P&L and the expense breakdown, plus CSV exports.
  // Same analytics.manage trust level as the analytics group; the P&L
  // surface additionally requires viewProfit (enforced in the handlers —
  // net profit is the store's most sensitive number).
  app.use(
    "/api/dashboard/reports",
    authenticate,
    resolveTenant,
    authorize("analytics.manage"),
    reportsRouter,
  );

  // Dashboard expenses: what the store spends, recorded against profit
  // (the P&L report reads these). Same analytics.manage trust level —
  // whoever is trusted to see profit is the one who records what
  // affects it. Writes are rate-limited inside the router.
  app.use(
    "/api/dashboard/expenses",
    authenticate,
    resolveTenant,
    authorize("analytics.manage"),
    expensesRouter,
  );

  // Dashboard campaigns: storefront promotions (banner + optional linked
  // coupon). A marketing decision, gated behind marketing.manage — the
  // same trust level as the other money-adjacent dashboard resources.
  // Writes are rate-limited inside the router.
  app.use(
    "/api/dashboard/campaigns",
    authenticate,
    resolveTenant,
    authorize("marketing.manage"),
    campaignsRouter,
  );

  // --- storefront templates (dashboard) -----------------------------------
  // The catalog read is authenticate-only, like /me: it must be
  // fetchable DURING onboarding (a tenant-less account gets the
  // pre-subscription STARTER set; the tier cut is resolved in the
  // service). The selection write is a storefront/branding setting —
  // owner-only, same trust level as subscriptions — mounted on the SAME
  // path: Express falls through the GET-only catalog router to it.
  app.use("/api/dashboard/templates", authenticate, templatesCatalogRouter);
  app.use(
    "/api/dashboard/templates",
    authenticate,
    resolveTenant,
    requireOwner,
    templatesSettingsRouter,
  );

  // Dashboard overview: the home-screen aggregation. Open to every tenant
  // member — the revenue-visibility boundary (viewProfit) is applied
  // inside the service, not by an authorize gate.
  app.use("/api/dashboard/overview", authenticate, resolveTenant, overviewRouter);

  // Dashboard settings: business profile and notification toggles are
  // owner-only merchant settings (same trust level as staff/payments);
  // writes are rate-limited. The password change endpoint lives at
  // /api/dashboard/settings/password (authenticate only) and is mounted
  // with the account group above.
  app.use(
    "/api/dashboard/settings",
    authenticate,
    resolveTenant,
    requireOwner,
    rateLimit({ windowMs: 60_000, max: 300 }),
    settingsRouter,
  );

  // Storefront settings (Website Studio): the same owner-only trust as
  // the settings group — what the storefront renders is a brand
  // decision, never a staff decision.
  app.use(
    "/api/dashboard/settings/storefront",
    authenticate,
    resolveTenant,
    requireOwner,
    rateLimit({ windowMs: 60_000, max: 300 }),
    storefrontSettingsRouter,
  );

  // Customers: the address book (explicit CRUD over rows POS/checkout
  // create implicitly) plus the credit-repayment lifecycle. Same trust
  // level as orders — the customers.manage permission, owners pass
  // implicitly. Writes are rate-limited inside the router.
  app.use(
    "/api/dashboard/customers",
    authenticate,
    resolveTenant,
    authorize("customers.manage"),
    customersRouter,
  );

  // Customer groups: segments of the address book, part of the customer
  // management surface — same customers.manage permission. Writes are
  // rate-limited inside the router.
  app.use(
    "/api/dashboard/customer-groups",
    authenticate,
    resolveTenant,
    authorize("customers.manage"),
    customerGroupsRouter,
  );

  // Discounts: reusable cart-wide discounts applied at sale time. Their
  // own discounts.manage permission (ADMIN role carries it); writes are
  // rate-limited inside the router.
  app.use(
    "/api/dashboard/discounts",
    authenticate,
    resolveTenant,
    authorize("discounts.manage"),
    discountsRouter,
  );

  // Invoices: money owed independent of fulfillment (draft -> issue ->
  // paid/void) with an append-only payment ledger. Same trust level as
  // orders/customers; the invoices.manage permission (ADMIN role already
  // carries it) gates the whole surface. Writes are rate-limited inside
  // the router.
  app.use(
    "/api/dashboard/invoices",
    authenticate,
    resolveTenant,
    authorize("invoices.manage"),
    invoicesRouter,
  );

  // Merchant alerts: the recent-dispatch inbox + test sender for the
  // notification engine (sweep + payment hooks live in the module, not
  // here). Owner-only, same trust level as settings — the toggles that
  // govern what gets emailed live under /api/dashboard/settings.
  app.use(
    "/api/dashboard/notifications",
    authenticate,
    resolveTenant,
    requireOwner,
    rateLimit({ windowMs: 60_000, max: 300 }),
    notificationsRouter,
  );

  // Suppliers: the vendor directory the purchasing surface draws from.
  // Same trust level as invoices; the purchases.manage permission gates
  // the whole surface (ADMIN role already carries it). Writes are
  // rate-limited inside the router.
  app.use(
    "/api/dashboard/suppliers",
    authenticate,
    resolveTenant,
    authorize("purchases.manage"),
    suppliersRouter,
  );

  // Purchase orders: goods ordered from a supplier (draft -> ordered ->
  // partially received/received or cancelled). Receiving is the only
  // way stock enters a PO — it writes RESTOCK stock-ledger movements in
  // the same transaction as the append-only receipt ledger. Same trust
  // level as invoices; the purchases.manage permission gates it.
  // Writes are rate-limited inside the router.
  app.use(
    "/api/dashboard/purchase-orders",
    authenticate,
    resolveTenant,
    authorize("purchases.manage"),
    purchaseOrdersRouter,
  );

  // --- admin group -------------------------------------------------------
  // Platform-staff tooling. The admin LOGIN half is public and
  // rate-limited (credentials + mandatory TOTP); everything else sits
  // behind requireAdminAuth (its own JWT secret — merchant tokens never
  // pass) with per-route requireAdminPermission guards. No resolveTenant:
  // admin actions are cross-store and audit-logged, never tenant-scoped.
  app.use("/api/admin/auth", rateLimit({ windowMs: 60_000, max: 300 }), adminAuthRouter);
  app.use("/api/admin", adminRouter);

  // --- 404 fallback ------------------------------------------------------
  // Any unmounted path is a 404, formatted by the global error handler.
  app.use((req, res, next) => {
    void req;
    next(new AppError(404, "NOT_FOUND", `Route ${req.method} ${req.path} not found`));
  });

  // --- global error handler (mounted last) -------------------------------
  app.use(errorHandler);

  return app;
}

export const app: Express = createApp();
