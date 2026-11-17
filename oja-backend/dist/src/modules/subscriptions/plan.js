/**
 * Per-tier defaults. null caps (ENTERPRISE) are passed through as unlimited.
 * The order of `active` membership is intentional: TRIALING is usable.
 */
export const TIER_PLANS = {
    STARTER: {
        limits: { staffCap: 1, locationCap: 1, productCap: 100, orderCap: 1000, templateCap: 3 },
        featureFlags: { customDomain: false, advancedAnalytics: false, marketingTools: false },
    },
    PRO: {
        limits: { staffCap: 10, locationCap: 3, productCap: 500, orderCap: 5000, templateCap: 5 },
        featureFlags: { customDomain: true, advancedAnalytics: true, marketingTools: false },
    },
    ENTERPRISE: {
        limits: {
            staffCap: null,
            locationCap: null,
            productCap: null,
            orderCap: null,
            templateCap: null,
        },
        featureFlags: { customDomain: true, advancedAnalytics: true, marketingTools: true },
    },
};
const USABLE_STATUS = new Set(["TRIALING", "ACTIVE"]);
/**
 * True when a PAST_DUE subscription is still within its grace window
 * (`pastDueAt + graceMs > now`). Pure — the sweep uses the same rule to
 * decide when to flip a graced subscription to enforced.
 */
export function isPastDueWithinGrace(pastDueAt, graceMs, now = new Date()) {
    if (pastDueAt === null || pastDueAt === undefined)
        return false;
    return now.getTime() < pastDueAt.getTime() + graceMs;
}
/**
 * Resolves a store's plan from its (possibly null) active subscription.
 * Pure: no Prisma access. A non-null cap on the row overrides the tier default;
 * a null subscription yields the STARTER tier view with every cap unlimited.
 *
 * `graceMs` (when provided) treats a PAST_DUE subscription as still usable
 * while within the grace window — used by the dashboard plan/usage reads and
 * the enforcement gates. When omitted, PAST_DUE is inactive (the sweep path
 * and legacy callers).
 */
export function resolvePlan(subscription, graceMs) {
    if (subscription === null) {
        return {
            tier: "STARTER",
            status: null,
            active: false,
            limits: {
                staffCap: null,
                locationCap: null,
                productCap: null,
                orderCap: null,
                templateCap: null,
            },
            featureFlags: { customDomain: false, advancedAnalytics: false, marketingTools: false },
        };
    }
    const tierDefaults = TIER_PLANS[subscription.tier];
    const row = {
        staffCap: subscription.staffCap,
        locationCap: subscription.locationCap,
        productCap: subscription.productCap,
        orderCap: subscription.orderCap,
        templateCap: subscription.templateCap,
    };
    return {
        tier: subscription.tier,
        status: subscription.status,
        // PAST_DUE is usable only while within the grace window (when the
        // caller supplies graceMs); otherwise only TRIALING/ACTIVE are usable.
        active: USABLE_STATUS.has(subscription.status) ||
            (subscription.status === "PAST_DUE" &&
                graceMs !== undefined &&
                isPastDueWithinGrace(subscription.pastDueAt, graceMs)),
        limits: {
            staffCap: row.staffCap ?? tierDefaults.limits.staffCap,
            locationCap: row.locationCap ?? tierDefaults.limits.locationCap,
            productCap: row.productCap ?? tierDefaults.limits.productCap,
            orderCap: row.orderCap ?? tierDefaults.limits.orderCap,
            templateCap: row.templateCap ?? tierDefaults.limits.templateCap,
        },
        featureFlags: tierDefaults.featureFlags,
    };
}
/**
 * Resolves the plan AND checks a single resource against its cap in one step.
 * Returns `{ allowed, cap, message }` so callers can throw the right error or
 * proceed. `count` is the live current usage. `null` cap ⇒ always allowed.
 * `count >= cap` is rejected — so exactly-at is the edge case the tests pin.
 */
export function checkCap(cap, count, resourceName, upgradePlan) {
    if (cap === null) {
        return { allowed: true, cap, message: "" };
    }
    const allowed = count < cap;
    return {
        allowed,
        cap,
        message: allowed
            ? ""
            : `This plan allows ${cap} ${resourceName}(s); the limit is reached — upgrade to ${upgradePlan} for more`,
    };
}
//# sourceMappingURL=plan.js.map