import { Prisma } from "../../../generated/prisma/client.js";
import type { Subscription } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { resolvePlan, checkCap, type SubscriptionPlan } from "./plan.js";

/** Minimal surface of a Prisma transaction client that the service uses. */
export type PlanTx = Pick<
  Prisma.TransactionClient,
  "store" | "subscription" | "product" | "order" | "location"
>;

export interface UsageAgainstLimits {
  plan: SubscriptionPlan;
  usage: { staff: number; locations: number; products: number; orders: number };
  period: { start: string; end: string };
  customDomain: string | null;
}

/**
 * Resolves a store's plan (tier + limits + feature flags). Returns `null`
 * when the store has no subscription (every cap reads as unlimited).
 */
export async function getPlan(storeId: string): Promise<SubscriptionPlan | null> {
  const subscription = await loadSubscription(storeId);
  return resolvePlan(subscription);
}

/**
 * Loads the store's active-relation subscription row (the row pointed at by
 * `Store.subscriptionId`), or `null` for a store with no subscription.
 * Shared by plan resolution, usage, and cap enforcement so every code path
 * reads the same row.
 */
export async function loadSubscription(storeId: string, tx?: PlanTx): Promise<Subscription | null> {
  const prisma: PlanTx = tx ?? (getPrismaClient() as unknown as PlanTx);
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { subscriptionId: true },
  });
  if (store?.subscriptionId === null || store?.subscriptionId === undefined) return null;
  return prisma.subscription.findUnique({ where: { id: store!.subscriptionId } });
}

/**
 * Cap gate for `createProduct`: counts non-deleted products for the tenant and
 * rejects with `409 PRODUCT_LIMIT_REACHED` when at/over the plan's productCap.
 * A store with no subscription (or a null productCap) is unlimited. Throws a
 * clear upgrade-promoting message, never a 500.
 */
export async function enforceProductCap(storeId: string, tx?: PlanTx): Promise<void> {
  const subscription = await loadSubscription(storeId, tx);
  const plan = resolvePlan(subscription);
  const cap = plan.limits.productCap;
  if (cap === null) return;

  const prisma: PlanTx = tx ?? (getPrismaClient() as unknown as PlanTx);
  const count = await prisma.product.count({ where: { storeId, deletedAt: null } });
  const gate = checkCap(cap, count, "product", plan.tier === "STARTER" ? "PRO" : "ENTERPRISE");
  if (!gate.allowed) {
    throw new AppError(409, "PRODUCT_LIMIT_REACHED", gate.message);
  }
}

/**
 * Cap gate for `createLocation`: counts Location rows for the tenant and
 * rejects with `409 LOCATION_LIMIT_REACHED` when at/over the plan's
 * locationCap. A store with no subscription (or a null locationCap) is
 * unlimited. Same boundary rule as the other caps: `count < cap` allowed,
 * `count == cap` rejected.
 */
export async function enforceLocationCap(storeId: string, tx?: PlanTx): Promise<void> {
  const subscription = await loadSubscription(storeId, tx);
  const plan = resolvePlan(subscription);
  const cap = plan.limits.locationCap;
  if (cap === null) return;

  const prisma: PlanTx = tx ?? (getPrismaClient() as unknown as PlanTx);
  const count = await prisma.location.count({ where: { storeId } });
  const gate = checkCap(cap, count, "location", plan.tier === "STARTER" ? "PRO" : "ENTERPRISE");
  if (!gate.allowed) {
    throw new AppError(409, "LOCATION_LIMIT_REACHED", gate.message);
  }
}

/**
 * Cap gate for `initiateCheckout`: counts orders created within the
 * subscription's billing period and rejects with `409 ORDER_LIMIT_REACHED`
 * when at/over the plan's orderCap. A store with no subscription (or a null
 * orderCap) is unlimited. Uses the same windowed count the usage endpoint
 * reports, so the dashboard figure and the gate stay in lockstep.
 */
export async function enforceOrderCap(storeId: string, tx?: PlanTx): Promise<void> {
  const subscription = await loadSubscription(storeId, tx);
  const plan = resolvePlan(subscription);
  const cap = plan.limits.orderCap;
  if (cap === null) return;

  const windowPeriod =
    subscription === null
      ? { start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), end: new Date() }
      : resolveOrderWindow(subscription);

  const prisma: PlanTx = tx ?? (getPrismaClient() as unknown as PlanTx);
  const count = await prisma.order.count({
    where: { storeId, createdAt: { gte: windowPeriod.start, lt: windowPeriod.end } },
  });
  const gate = checkCap(cap, count, "order", plan.tier === "STARTER" ? "PRO" : "ENTERPRISE");
  if (!gate.allowed) {
    throw new AppError(409, "ORDER_LIMIT_REACHED", gate.message);
  }
}

/**
 * Loads the store's subscription and resolves the plan; throws 403
 * `SUBSCRIPTION_INACTIVE` if there is no subscription or it is not ACTIVE/
 * TRIALING. Accepts an injected tx so callers can fold the read into their
 * own transaction (plan-gated writes such as product create / order checkout).
 */
export async function requireActiveSubscription(
  storeId: string,
  tx?: PlanTx,
): Promise<SubscriptionPlan> {
  const prisma: PlanTx = tx ?? (getPrismaClient() as unknown as PlanTx);
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { id: true, subscriptionId: true },
  });
  if (store === null) {
    throw new AppError(404, "NOT_FOUND", "Store not found");
  }
  if (store.subscriptionId === null) {
    throw new AppError(
      403,
      "SUBSCRIPTION_INACTIVE",
      "This store has no active subscription — choose a plan to create products and orders",
    );
  }

  const subscription = await prisma.subscription.findUnique({
    where: { id: store.subscriptionId },
  });
  if (subscription === null) {
    throw new AppError(
      403,
      "SUBSCRIPTION_INACTIVE",
      "This store has no active subscription — choose a plan to create products and orders",
    );
  }

  const plan = resolvePlan(subscription);
  if (!plan.active) {
    throw new AppError(
      403,
      "SUBSCRIPTION_INACTIVE",
      `Your subscription is ${subscription.status}; reactivate to create products and orders`,
    );
  }
  return plan;
}

/**
 * Billing-period window for the rolling `orderCap`. `currentPeriodEnd` is
 * always present; `currentPeriodStart` is present for subscriptions created
 * this phase, falling back to `end − 30 days` for legacy rows.
 */
export function resolveOrderWindow(subscription: Subscription): { start: Date; end: Date } {
  const end = subscription.currentPeriodEnd;
  const start =
    subscription.currentPeriodStart ?? new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { start, end };
}

/** Live usage against the resolved plan — the dashboard endpoint's payload. */
export async function getUsageAgainstLimits(
  storeId: string,
  context: { customDomain: string | null } = { customDomain: null },
): Promise<UsageAgainstLimits> {
  const prisma = getPrismaClient();
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { id: true, subscriptionId: true, customDomain: true },
  });
  if (store === null) {
    throw new AppError(404, "NOT_FOUND", "Store not found");
  }

  let subscription: Subscription | null = null;
  if (store.subscriptionId !== null) {
    subscription = await prisma.subscription.findUnique({
      where: { id: store.subscriptionId },
    });
  }
  const plan = resolvePlan(subscription);
  const customDomain = context.customDomain ?? store.customDomain;

  const orderWindow =
    subscription === null
      ? { start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), end: new Date() }
      : resolveOrderWindow(subscription);

  const [staff, locations, products, orders] = await Promise.all([
    prisma.staffMember.count({ where: { storeId } }),
    prisma.location.count({ where: { storeId } }),
    prisma.product.count({ where: { storeId, deletedAt: null } }),
    prisma.order.count({
      where: { storeId, createdAt: { gte: orderWindow.start, lt: orderWindow.end } },
    }),
  ]);

  return {
    plan,
    usage: { staff, locations, products, orders },
    period: { start: orderWindow.start.toISOString(), end: orderWindow.end.toISOString() },
    customDomain,
  };
}

/**
 * Sets the store's custom domain, gated by the plan's `customDomain` feature
 * flag. Order of checks:
 *   1. `requireActiveSubscription` — no/inactive subscription → 403
 *      SUBSCRIPTION_INACTIVE (you cannot configure features without a plan).
 *   2. `featureFlags.customDomain` — tier does not include it → 403
 *      PLAN_FEATURE_LOCKED (runs BEFORE any domain write, so a direct API
 *      bypass attempt is rejected identically to the UI flow).
 *   3. `Store.customDomain` unique write — another store already claimed it
 *      → 409 CUSTOM_DOMAIN_TAKEN.
 */
export async function setCustomDomain(
  storeId: string,
  customDomain: string,
): Promise<{ customDomain: string }> {
  const plan = await requireActiveSubscription(storeId);
  if (!plan.featureFlags.customDomain) {
    const upgrade =
      plan.tier === "STARTER" ? "upgrade to PRO" : "contact us for access to this feature";
    throw new AppError(
      403,
      "PLAN_FEATURE_LOCKED",
      `Custom domains are not included in your ${plan.tier} plan — ${upgrade} to use one`,
    );
  }

  const prisma = getPrismaClient();
  try {
    await prisma.store.update({
      where: { id: storeId },
      data: { customDomain },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new AppError(
        409,
        "CUSTOM_DOMAIN_TAKEN",
        `"${customDomain}" is already in use by another store`,
      );
    }
    throw err;
  }
  return { customDomain };
}

export type { SubscriptionPlan };
