import { Prisma } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";
import { env } from "../../config/env.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { createPaystackProvider } from "../../lib/providers/paystack.js";
import { logStoreActivity } from "../activity/service.js";
import { TIER_PLANS } from "./plan.js";
import { loadSubscription, resolveOrderWindow } from "./service.js";
/**
 * ============================================================
 * SUBSCRIPTION BILLING SERVICE — the platform's recurring billing
 * ============================================================
 *
 * The merchant self-serves a plan: checkout subscribes (Paystack plan +
 * one-time first payment), renewals are automatic, upgrades charge the
 * prorated difference and switch the plan at charge-success, downgrades
 * are deferred to the current period end, and cancellation disables the
 * Paystack subscription.
 *
 * Money touches the PLATFORM's Paystack account (env PLATFORM_PAYSTACK_*),
 * never the merchant's own storefront keys. Every money movement is
 * recorded in the append-only SubscriptionPayment table; the single
 * active Subscription row is mutated in place across the lifecycle.
 * ============================================================
 */
/** Reference prefixes distinguish payment purpose (webhook correlation). */
const REF_SUBSCRIBE = "sub_";
const REF_UPGRADE = "upg_";
const CYCLE_DAYS = 30;
const defaultProviderFactory = ({ publicKey, secretKey }) => createPaystackProvider({ publicKey, secretKey });
function generateReference(prefix) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let suffix = "";
    for (let i = 0; i < 14; i++) {
        suffix += chars[Math.floor(Math.random() * chars.length)];
    }
    return `${prefix}${suffix}`;
}
/** Loads the store owner's email (the Paystack customer email). */
async function ownerEmail(storeId) {
    const row = await getPrismaClient().store.findUnique({
        where: { id: storeId },
        select: { owner: { select: { account: { select: { email: true } } } } },
    });
    const email = row?.owner?.account?.email;
    if (email === undefined || email === null) {
        throw new AppError(409, "OWNER_EMAIL_MISSING", "This store has no owner email to bill — contact support");
    }
    return email;
}
/** The admin-set pricing + plan code for a tier, or 409 when unconfigured. */
async function tierPricing(storeId, tier) {
    const row = await getPrismaClient().subscriptionPlanSetting.findUnique({
        where: { plan: tier },
    });
    if (row === null || row.monthlyPrice === null || row.paystackPlanCode === null) {
        throw new AppError(409, "PRICING_NOT_CONFIGURED", `Pricing for the ${tier} plan is not configured yet — contact support`);
    }
    return {
        monthlyPrice: row.monthlyPrice.toFixed(2),
        paystackPlanCode: row.paystackPlanCode,
    };
}
/** The store's active subscription row, or 409 when none. */
async function requireSubscription(storeId) {
    const subscription = await loadSubscription(storeId);
    if (subscription === null) {
        throw new AppError(409, "NO_SUBSCRIPTION", "This store has no active subscription");
    }
    return subscription.tier;
}
/**
 * POST /subscriptions/checkout — subscribe to a plan. Reads the admin-set
 * price + Paystack plan, opens a checkout that bills the first month and
 * subscribes the merchant, and records a PENDING SUBSCRIPTION payment.
 */
export async function initiateSubscriptionCheckout(storeId, tier, providerFactory = defaultProviderFactory) {
    const pricing = await tierPricing(storeId, tier);
    const email = await ownerEmail(storeId);
    const existing = await loadSubscription(storeId);
    if (existing !== null && existing.status !== "CANCELLED") {
        throw new AppError(409, "ALREADY_SUBSCRIBED", "This store already has an active subscription — upgrade or downgrade instead");
    }
    const provider = providerFactory({
        publicKey: env.PLATFORM_PAYSTACK_PUBLIC_KEY,
        secretKey: env.PLATFORM_PAYSTACK_SECRET_KEY,
    });
    const init = provider.initializeSubscription;
    if (init === undefined) {
        throw new AppError(502, "PROVIDER_UNSUPPORTED", "The payment provider does not support billing");
    }
    const reference = generateReference(REF_SUBSCRIBE);
    const checkout = await init({
        planCode: pricing.paystackPlanCode,
        email,
        reference,
        metadata: { storeId, tier, kind: "SUBSCRIPTION" },
    });
    const prisma = getPrismaClient();
    await prisma.subscriptionPayment.create({
        data: {
            storeId,
            tier,
            kind: "SUBSCRIPTION",
            status: "PENDING",
            reference,
            amount: new Prisma.Decimal(pricing.monthlyPrice),
        },
    });
    await logStoreActivity(prisma, {
        storeId,
        staffMemberId: null,
        action: "subscription.checkout.initiated",
        detail: { tier, reference, amount: pricing.monthlyPrice },
    });
    return {
        reference,
        authorizationUrl: checkout.authorizationUrl,
        amount: pricing.monthlyPrice,
        tier,
    };
}
/** Prorated difference for upgrading from `fromTier` to `toTier`. */
export function proratedUpgradeAmount(fromPrice, toPrice, remainingDays, cycleDays = CYCLE_DAYS) {
    const oldPrice = new Prisma.Decimal(fromPrice);
    const newPrice = new Prisma.Decimal(toPrice);
    if (newPrice.lte(oldPrice)) {
        throw new AppError(409, "UPGRADE_NOT_HIGHER", "The target tier is not a higher-priced plan");
    }
    const diff = newPrice.sub(oldPrice);
    const fraction = new Prisma.Decimal(remainingDays).div(cycleDays);
    return diff.mul(fraction).toFixed(2);
}
/**
 * POST /subscriptions/upgrade — charge the prorated difference now; the
 * tier + caps apply immediately at charge-success (webhook), where the
 * Paystack subscription is also switched to the new plan. No immediate
 * plan switch here — the deterministic switch lives in the webhook so a
 * failed payment never half-upgrades the store.
 */
export async function initiateSubscriptionUpgrade(storeId, tier, providerFactory = defaultProviderFactory) {
    const currentTier = await requireSubscription(storeId);
    if (currentTier === tier) {
        throw new AppError(409, "ALREADY_ON_TIER", `This store is already on the ${tier} plan`);
    }
    const currentPricing = await tierPricing(storeId, currentTier);
    const targetPricing = await tierPricing(storeId, tier);
    const currentPrice = new Prisma.Decimal(currentPricing.monthlyPrice);
    const targetPrice = new Prisma.Decimal(targetPricing.monthlyPrice);
    if (targetPrice.lte(currentPrice)) {
        throw new AppError(409, "UPGRADE_NOT_HIGHER", "Use downgrade for a lower-priced plan");
    }
    const subscription = await loadSubscription(storeId);
    const remainingDays = Math.max(0, Math.ceil(((subscription?.currentPeriodEnd ?? new Date()).getTime() - Date.now()) / 86_400_000));
    const proratedAmount = proratedUpgradeAmount(currentPricing.monthlyPrice, targetPricing.monthlyPrice, remainingDays);
    if (new Prisma.Decimal(proratedAmount).isZero()) {
        throw new AppError(409, "PRORATION_ZERO", "There is no time left in this cycle — wait for renewal to change plans");
    }
    const email = await ownerEmail(storeId);
    const provider = providerFactory({
        publicKey: env.PLATFORM_PAYSTACK_PUBLIC_KEY,
        secretKey: env.PLATFORM_PAYSTACK_SECRET_KEY,
    });
    const init = provider.initiateCheckout;
    if (init === undefined) {
        throw new AppError(502, "PROVIDER_UNSUPPORTED", "The payment provider does not support billing");
    }
    // One-off transaction (no plan) for the prorated diff — the plan switch
    // happens deterministically at charge-success in the webhook.
    const reference = generateReference(REF_UPGRADE);
    const checkout = await init({
        amount: proratedAmount,
        currency: "NGN",
        email,
        reference,
        metadata: { storeId, tier, kind: "UPGRADE", fromTier: currentTier },
    });
    const prisma = getPrismaClient();
    await prisma.subscriptionPayment.create({
        data: {
            storeId,
            tier,
            kind: "UPGRADE",
            status: "PENDING",
            reference,
            amount: new Prisma.Decimal(proratedAmount),
        },
    });
    await logStoreActivity(prisma, {
        storeId,
        staffMemberId: null,
        action: "subscription.upgrade.initiated",
        detail: { fromTier: currentTier, toTier: tier, reference, proratedAmount },
    });
    return {
        reference,
        authorizationUrl: checkout.authorizationUrl,
        proratedAmount,
        tier,
        effectiveImmediately: true,
    };
}
/**
 * Live usage vs the target tier's caps + features — never stored, so the
 * warnings stay accurate for the whole deferral window.
 */
export async function computeDowngradeWarnings(storeId, targetTier) {
    const prisma = getPrismaClient();
    const subscription = await loadSubscription(storeId);
    if (subscription === null) {
        throw new AppError(409, "NO_SUBSCRIPTION", "This store has no active subscription");
    }
    const currentTier = subscription.tier;
    const target = TIER_PLANS[targetTier];
    const warnings = [];
    const orderWindow = resolveOrderWindow(subscription);
    const [staff, locations, products, orders] = await Promise.all([
        prisma.staffMember.count({ where: { storeId } }),
        prisma.location.count({ where: { storeId } }),
        prisma.product.count({ where: { storeId, deletedAt: null } }),
        prisma.order.count({
            where: { storeId, createdAt: { gte: orderWindow.start, lt: orderWindow.end } },
        }),
    ]);
    const check = (resource, current, cap) => {
        if (cap !== null && current >= cap) {
            warnings.push({
                type: "OVER_CAP",
                resource,
                current,
                targetCap: cap,
                excess: current - cap,
                message: `You have ${current} ${resource}; ${targetTier} allows ${cap}. You won't be able to add more until you are back under the limit.`,
            });
        }
    };
    check("staff", staff, target.limits.staffCap);
    check("locations", locations, target.limits.locationCap);
    check("products", products, target.limits.productCap);
    check("orders", orders, target.limits.orderCap);
    // Feature flags lost on downgrade.
    const lostFeatures = Object.keys(target.featureFlags).filter((feature) => TIER_PLANS[currentTier].featureFlags[feature] && !target.featureFlags[feature]);
    for (const feature of lostFeatures) {
        warnings.push({
            type: "FEATURE_LOST",
            feature,
            message: `Your ${feature} will stop working when the change takes effect.`,
        });
    }
    // Template outside the target tier's visible set.
    const template = await prisma.store.findUnique({
        where: { id: storeId },
        select: { template: { select: { id: true, name: true } } },
    });
    if (template?.template !== null && template?.template !== undefined) {
        const templates = await prisma.storeTemplate.findMany({
            where: { isActive: true },
            orderBy: { sortOrder: "asc" },
            select: { id: true },
        });
        const visibleSet = templates.slice(0, target.limits.templateCap ?? templates.length);
        if (!visibleSet.some((t) => t.id === template.template.id)) {
            warnings.push({
                type: "TEMPLATE_LOST",
                message: "Your selected storefront template is not included in the target plan.",
            });
        }
    }
    return warnings;
}
/**
 * POST /subscriptions/downgrade — schedule a deferred downgrade. The store
 * keeps its current tier/features until currentPeriodEnd; the sweep applies
 * the change then. Returns the warnings so the UI can display them.
 */
export async function scheduleSubscriptionDowngrade(storeId, tier) {
    const currentTier = await requireSubscription(storeId);
    if (currentTier === tier) {
        throw new AppError(409, "ALREADY_ON_TIER", `This store is already on the ${tier} plan`);
    }
    const subscription = await loadSubscription(storeId);
    const currentPricing = await tierPricing(storeId, currentTier);
    const targetPricing = await tierPricing(storeId, tier);
    if (new Prisma.Decimal(targetPricing.monthlyPrice).gte(new Prisma.Decimal(currentPricing.monthlyPrice))) {
        throw new AppError(409, "DOWNGRADE_NOT_LOWER", "Use upgrade for a higher-priced plan");
    }
    const effectiveAt = subscription?.currentPeriodEnd ?? new Date();
    const warnings = await computeDowngradeWarnings(storeId, tier);
    const prisma = getPrismaClient();
    await prisma.subscription.update({
        where: { id: subscription.id },
        data: { pendingDowngradeTier: tier },
    });
    await logStoreActivity(prisma, {
        storeId,
        staffMemberId: null,
        action: "subscription.downgrade.scheduled",
        detail: { fromTier: currentTier, toTier: tier, effectiveAt: effectiveAt.toISOString() },
    });
    return {
        currentTier,
        targetTier: tier,
        effectiveAt: effectiveAt.toISOString(),
        warnings,
    };
}
/** POST /subscriptions/cancel — disable the Paystack subscription. */
export async function cancelSubscription(storeId, providerFactory = defaultProviderFactory) {
    const subscription = await loadSubscription(storeId);
    if (subscription === null) {
        throw new AppError(409, "NO_SUBSCRIPTION", "This store has no active subscription");
    }
    if (subscription.paystackSubscriptionCode === null) {
        throw new AppError(409, "NO_PAYSTACK_SUBSCRIPTION", "This subscription has no Paystack billing to cancel");
    }
    const provider = providerFactory({
        publicKey: env.PLATFORM_PAYSTACK_PUBLIC_KEY,
        secretKey: env.PLATFORM_PAYSTACK_SECRET_KEY,
    });
    const disable = provider.disableRecurringSubscription;
    if (disable !== undefined) {
        await disable({
            subscriptionCode: subscription.paystackSubscriptionCode,
            emailToken: subscription.paystackEmailToken ?? "",
        });
    }
    const prisma = getPrismaClient();
    await prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: "CANCELLED", pendingDowngradeTier: null },
    });
    await logStoreActivity(prisma, {
        storeId,
        staffMemberId: null,
        action: "subscription.cancelled",
        detail: { subscriptionId: subscription.id },
    });
}
/** Payment history + detail views. */
export async function listSubscriptionPayments(storeId) {
    const rows = await getPrismaClient().subscriptionPayment.findMany({
        where: { storeId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return rows.map((row) => ({
        id: row.id,
        tier: row.tier,
        kind: row.kind,
        status: row.status,
        reference: row.reference,
        amount: row.amount.toFixed(2),
        paidAt: row.paidAt,
        createdAt: row.createdAt,
        orphanReason: row.orphanReason,
    }));
}
export async function getSubscriptionPayment(storeId, paymentId) {
    const row = await getPrismaClient().subscriptionPayment.findFirst({
        where: { id: paymentId, storeId },
    });
    if (row === null) {
        throw new AppError(404, "PAYMENT_NOT_FOUND", "Payment not found");
    }
    return {
        id: row.id,
        tier: row.tier,
        kind: row.kind,
        status: row.status,
        reference: row.reference,
        amount: row.amount.toFixed(2),
        providerRef: row.providerRef,
        paidAt: row.paidAt,
        createdAt: row.createdAt,
        orphanReason: row.orphanReason,
    };
}
//# sourceMappingURL=billing.service.js.map