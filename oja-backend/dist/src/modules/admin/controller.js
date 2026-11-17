import { AppError } from "../../lib/AppError.js";
import { adminLoginSchema, adminRefreshSchema, adminResetSchema, auditQuerySchema, churnQuerySchema, signupsQuerySchema, searchStoresSchema, pricingUpdateSchema, orphanedOrdersQuerySchema, merchantsQuerySchema, storesViewQuerySchema, ordersViewQuerySchema, parseMetricRange, } from "./schemas.js";
import { AdminService } from "./service.js";
import { validateOrThrow } from "../../lib/validate.js";
/**
 * Thin controllers: every business rule and Prisma call lives in
 * AdminService. Controllers only parse input, read the auth context, and
 * serialize the service's answer.
 */
const service = new AdminService();
export function loginHandler(req, res, next) {
    void res;
    try {
        const input = validateOrThrow(adminLoginSchema, req.body);
        service
            .login(input.email, input.password, input.totpToken, sessionContext(req))
            .then((session) => {
            res.json(session);
        })
            .catch((err) => next(err));
    }
    catch (err) {
        next(err);
    }
}
export function adminRefreshHandler(req, res, next) {
    try {
        const { refreshToken } = validateOrThrow(adminRefreshSchema, req.body);
        service
            .refreshAdmin(refreshToken, sessionContext(req))
            .then((session) => {
            res.json(session);
        })
            .catch((err) => next(err));
    }
    catch (err) {
        next(err);
    }
}
export function adminLogoutHandler(req, res, next) {
    try {
        const { refreshToken } = validateOrThrow(adminRefreshSchema, req.body);
        service
            .logoutAdmin(refreshToken)
            .then(() => {
            res.status(204).end();
        })
            .catch((err) => next(err));
    }
    catch (err) {
        next(err);
    }
}
function requireAdmin(req) {
    if (req.admin === undefined) {
        throw new AppError(401, "UNAUTHORIZED", "Authentication required");
    }
    return req.admin;
}
function sessionContext(req) {
    return { ipAddress: req.ip || null, userAgent: req.get("user-agent") ?? null };
}
/** Express 5 types route params loosely; the routes always declare :name. */
function routeParam(req, name) {
    const value = req.params[name];
    if (typeof value !== "string" || value === "") {
        throw new AppError(400, "VALIDATION_ERROR", `${name} is required`);
    }
    return value;
}
export function meHandler(req, res, next) {
    try {
        const admin = requireAdmin(req);
        service
            .getMe(admin.adminUserId)
            .then((me) => res.json(me))
            .catch((err) => next(err));
    }
    catch (err) {
        next(err);
    }
}
export function rotateTwoFactorHandler(req, res, next) {
    try {
        const admin = requireAdmin(req);
        service
            .rotateTwoFactor(admin.adminUserId, admin.email)
            .then((rotated) => res.json(rotated))
            .catch((err) => next(err));
    }
    catch (err) {
        next(err);
    }
}
export function resetTwoFactorHandler(req, res, next) {
    try {
        const admin = requireAdmin(req);
        const input = validateOrThrow(adminResetSchema, req.body);
        service
            .resetTwoFactor(admin, input.adminUserId)
            .then((reset) => res.json(reset))
            .catch((err) => next(err));
    }
    catch (err) {
        next(err);
    }
}
export function auditLogHandler(req, res, next) {
    try {
        const admin = requireAdmin(req);
        const query = validateOrThrow(auditQuerySchema, req.query);
        service
            .listAuditLog(admin, query)
            .then((result) => res.json(result))
            .catch((err) => next(err));
    }
    catch (err) {
        next(err);
    }
}
export function searchStoresHandler(req, res, next) {
    try {
        requireAdmin(req);
        const query = validateOrThrow(searchStoresSchema, req.query);
        service
            .searchStores(query)
            .then((result) => res.json(result))
            .catch((err) => next(err));
    }
    catch (err) {
        next(err);
    }
}
export function storeDetailHandler(req, res, next) {
    try {
        requireAdmin(req);
        service
            .getStoreDetail(routeParam(req, "storeId"))
            .then((detail) => res.json(detail))
            .catch((err) => next(err));
    }
    catch (err) {
        next(err);
    }
}
export function signupsHandler(req, res, next) {
    try {
        requireAdmin(req);
        const query = validateOrThrow(signupsQuerySchema, req.query);
        service
            .getSignups(new Date(query.start), new Date(query.end), query.granularity)
            .then((result) => res.json(result))
            .catch((err) => next(err));
    }
    catch (err) {
        next(err);
    }
}
export function activationHandler(req, res, next) {
    try {
        requireAdmin(req);
        const { start, end } = parseMetricRange(req.query);
        service
            .getActivation(start, end)
            .then((result) => res.json(result))
            .catch((err) => next(err));
    }
    catch (err) {
        next(err);
    }
}
export function subscriptionsHealthHandler(req, res, next) {
    try {
        requireAdmin(req);
        service
            .getSubscriptionHealth()
            .then((result) => res.json(result))
            .catch((err) => next(err));
    }
    catch (err) {
        next(err);
    }
}
export function churnHandler(req, res, next) {
    try {
        requireAdmin(req);
        const query = validateOrThrow(churnQuerySchema, req.query);
        service
            .getChurn(new Date(query.start), new Date(query.end))
            .then((result) => res.json(result))
            .catch((err) => next(err));
    }
    catch (err) {
        next(err);
    }
}
export function telemetryFunnelHandler(req, res, next) {
    try {
        const admin = requireAdmin(req);
        const { start, end } = parseMetricRange(req.query);
        service
            .getTelemetryFunnel(admin.adminUserId, start, end)
            .then((result) => res.json(result))
            .catch((err) => next(err));
    }
    catch (err) {
        next(err);
    }
}
export function medianTimeToFirstOrderHandler(req, res, next) {
    try {
        const admin = requireAdmin(req);
        const { start, end } = parseMetricRange(req.query);
        service
            .getMedianTimeToFirstOrder(admin.adminUserId, start, end)
            .then((result) => res.json(result))
            .catch((err) => next(err));
    }
    catch (err) {
        next(err);
    }
}
export function listPricingHandler(req, res, next) {
    try {
        requireAdmin(req);
        service
            .listPricing()
            .then((result) => res.json(result))
            .catch((err) => next(err));
    }
    catch (err) {
        next(err);
    }
}
export function updatePricingHandler(req, res, next) {
    try {
        const admin = requireAdmin(req);
        const input = validateOrThrow(pricingUpdateSchema, req.body);
        service
            .updatePricing(routeParam(req, "plan"), input.monthlyPrice, admin.adminUserId, input.paystackPlanCode)
            .then((result) => res.json(result))
            .catch((err) => next(err));
    }
    catch (err) {
        next(err);
    }
}
export function reprocessWebhookHandler(req, res, next) {
    try {
        const admin = requireAdmin(req);
        service
            .reprocessWebhook(routeParam(req, "eventId"), admin.adminUserId)
            .then((result) => res.json(result))
            .catch((err) => next(err));
    }
    catch (err) {
        next(err);
    }
}
export function ledgerAnomaliesHandler(req, res, next) {
    try {
        requireAdmin(req);
        service
            .getLedgerAnomalies()
            .then((result) => res.json(result))
            .catch((err) => next(err));
    }
    catch (err) {
        next(err);
    }
}
export function orphanedOrdersHandler(req, res, next) {
    try {
        requireAdmin(req);
        const query = validateOrThrow(orphanedOrdersQuerySchema, req.query);
        service
            .getOrphanedOrders(query.hours)
            .then((result) => res.json(result))
            .catch((err) => next(err));
    }
    catch (err) {
        next(err);
    }
}
export function moderationQueueHandler(req, res, next) {
    try {
        requireAdmin(req);
        service
            .getModerationQueue()
            .then((result) => res.json(result))
            .catch((err) => next(err));
    }
    catch (err) {
        next(err);
    }
}
export function overviewHandler(req, res, next) {
    try {
        const admin = requireAdmin(req);
        service
            .getOverview(admin.adminUserId)
            .then((result) => res.json(result))
            .catch((err) => next(err));
    }
    catch (err) {
        next(err);
    }
}
export function merchantsHandler(req, res, next) {
    try {
        const admin = requireAdmin(req);
        const query = validateOrThrow(merchantsQuerySchema, req.query);
        service
            .listMerchants(admin.adminUserId, query)
            .then((result) => res.json(result))
            .catch((err) => next(err));
    }
    catch (err) {
        next(err);
    }
}
export function storesFleetHandler(req, res, next) {
    try {
        const admin = requireAdmin(req);
        const query = validateOrThrow(storesViewQuerySchema, req.query);
        service
            .listStoresFleet(admin.adminUserId, query)
            .then((result) => res.json(result))
            .catch((err) => next(err));
    }
    catch (err) {
        next(err);
    }
}
export function ordersHandler(req, res, next) {
    try {
        const admin = requireAdmin(req);
        const query = validateOrThrow(ordersViewQuerySchema, req.query);
        service
            .listOrders(admin.adminUserId, query)
            .then((result) => res.json(result))
            .catch((err) => next(err));
    }
    catch (err) {
        next(err);
    }
}
export function awaitingPaymentOrdersHandler(req, res, next) {
    try {
        const admin = requireAdmin(req);
        service
            .listAwaitingPaymentOrders(admin.adminUserId)
            .then((result) => res.json(result))
            .catch((err) => next(err));
    }
    catch (err) {
        next(err);
    }
}
export function adminStaffHandler(req, res, next) {
    try {
        const admin = requireAdmin(req);
        service
            .listAdminStaff(admin.adminUserId)
            .then((result) => res.json(result))
            .catch((err) => next(err));
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=controller.js.map