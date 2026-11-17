import { AppError } from "../../lib/AppError.js";
import { validateOrThrow } from "../../lib/validate.js";
import { setCustomDomainSchema, subscriptionCheckoutSchema, subscriptionChangeTierSchema } from "./schemas.js";
import { getPlan, getUsageAgainstLimits, setCustomDomain } from "./service.js";
import { cancelSubscription, computeDowngradeWarnings, getSubscriptionPayment, initiateSubscriptionCheckout, initiateSubscriptionUpgrade, listSubscriptionPayments, scheduleSubscriptionDowngrade, } from "./billing.service.js";
import { loadSubscription } from "./service.js";
function requireTenant(req) {
    const tenant = req.tenant;
    if (tenant === undefined) {
        throw new AppError(401, "UNAUTHORIZED", "Authentication required");
    }
    return { storeId: tenant.storeId };
}
/** GET /api/dashboard/subscriptions/usage */
export async function getUsageHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        res.status(200).json(await getUsageAgainstLimits(storeId));
    }
    catch (err) {
        next(err);
    }
}
/** GET /api/dashboard/subscriptions/plan */
export async function getPlanHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        const plan = await getPlan(storeId);
        const subscription = await loadSubscription(storeId);
        const pendingDowngrade = subscription !== null && subscription.pendingDowngradeTier !== null
            ? {
                tier: subscription.pendingDowngradeTier,
                effectiveAt: (subscription.currentPeriodEnd ?? new Date()).toISOString(),
                warnings: await computeDowngradeWarnings(storeId, subscription.pendingDowngradeTier),
            }
            : null;
        // Backward-compatible: the plan fields stay at the top level (existing
        // consumers), and the pending downgrade is a sibling extension.
        res.status(200).json({ ...plan, pendingDowngrade });
    }
    catch (err) {
        next(err);
    }
}
/** PUT /api/dashboard/subscriptions/custom-domain */
export async function setCustomDomainHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        const data = validateOrThrow(setCustomDomainSchema, req.body);
        res.status(200).json(await setCustomDomain(storeId, data.customDomain));
    }
    catch (err) {
        next(err);
    }
}
/** POST /api/dashboard/subscriptions/checkout */
export async function checkoutHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        const data = validateOrThrow(subscriptionCheckoutSchema, req.body);
        res.status(201).json(await initiateSubscriptionCheckout(storeId, data.tier));
    }
    catch (err) {
        next(err);
    }
}
/** POST /api/dashboard/subscriptions/upgrade */
export async function upgradeHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        const data = validateOrThrow(subscriptionChangeTierSchema, req.body);
        res.status(201).json(await initiateSubscriptionUpgrade(storeId, data.tier));
    }
    catch (err) {
        next(err);
    }
}
/** POST /api/dashboard/subscriptions/downgrade */
export async function downgradeHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        const data = validateOrThrow(subscriptionChangeTierSchema, req.body);
        res.status(200).json(await scheduleSubscriptionDowngrade(storeId, data.tier));
    }
    catch (err) {
        next(err);
    }
}
/** GET /api/dashboard/subscriptions/downgrade/preview?tier=... */
export async function downgradePreviewHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        const tier = String(req.query.tier ?? "").toUpperCase();
        if (!["STARTER", "PRO", "ENTERPRISE"].includes(tier)) {
            throw new AppError(400, "VALIDATION_ERROR", "tier must be STARTER, PRO, or ENTERPRISE");
        }
        const subscription = await loadSubscription(storeId);
        const effectiveAt = (subscription?.currentPeriodEnd ?? new Date()).toISOString();
        const warnings = await computeDowngradeWarnings(storeId, tier);
        res.status(200).json({ currentTier: subscription?.tier ?? null, targetTier: tier, effectiveAt, warnings });
    }
    catch (err) {
        next(err);
    }
}
/** POST /api/dashboard/subscriptions/cancel */
export async function cancelHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        await cancelSubscription(storeId);
        res.status(200).json({ ok: true });
    }
    catch (err) {
        next(err);
    }
}
/** GET /api/dashboard/subscriptions/payments */
export async function listPaymentsHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        res.status(200).json({ items: await listSubscriptionPayments(storeId) });
    }
    catch (err) {
        next(err);
    }
}
/** GET /api/dashboard/subscriptions/payments/:id */
export async function getPaymentHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        const paymentId = req.params.paymentId;
        if (typeof paymentId !== "string" || paymentId === "") {
            throw new AppError(400, "VALIDATION_ERROR", "Payment ID is required");
        }
        res.status(200).json(await getSubscriptionPayment(storeId, paymentId));
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=controller.js.map