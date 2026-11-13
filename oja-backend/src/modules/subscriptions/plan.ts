import type { $Enums, Subscription as SubscriptionRow } from "../../../generated/prisma/client.js";

/**
 * ============================================================
 * PLAN / CAP MODEL
 * ============================================================
 *
 * A plan describes what a store's active subscription allows. The tier's
 * defaults live here as a constant table; individual cap columns on the
 * `Subscription` row MAY override them (a non-null cap wins). A store with no
 * subscription — or a null cap — has no limit on that resource.
 *
 * Feature flags are derived from the tier only. They are NOT stored per-row:
 * adding a new gate never needs a migration, only a tier-table entry.
 * ============================================================
 */

export type Tier = $Enums.SubscriptionTier;
export type SubscriptionStatus = $Enums.SubscriptionStatus;

export interface FeatureFlags {
  customDomain: boolean;
  advancedAnalytics: boolean;
  marketingTools: boolean;
}

export interface PlanLimits {
  /** Active `StaffMember` rows allowed (null = unlimited). */
  staffCap: number | null;
  /** Locations allowed (null = unlimited). NOT enforced — read-only. */
  locationCap: number | null;
  /** Non-deleted `Product` rows allowed (null = unlimited). */
  productCap: number | null;
  /** Orders created in the billing period allowed (null = unlimited). */
  orderCap: number | null;
  /**
   * Visible storefront templates (null = all). Unlike the resource caps,
   * a store with NO subscription is NOT unlimited here — the templates
   * service treats the pre-subscription state as the STARTER set (3).
   */
  templateCap: number | null;
}

export interface SubscriptionPlan {
  tier: Tier;
  status: SubscriptionStatus | null;
  /** True when the subscription is usable: ACTIVE or TRIALING. */
  active: boolean;
  limits: PlanLimits;
  featureFlags: FeatureFlags;
}

/**
 * Per-tier defaults. null caps (ENTERPRISE) are passed through as unlimited.
 * The order of `active` membership is intentional: TRIALING is usable.
 */
export const TIER_PLANS: Record<Tier, { limits: PlanLimits; featureFlags: FeatureFlags }> = {
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

const USABLE_STATUS: ReadonlySet<SubscriptionStatus> = new Set(["TRIALING", "ACTIVE"]);

/**
 * True when a PAST_DUE subscription is still within its grace window
 * (`pastDueAt + graceMs > now`). Pure — the sweep uses the same rule to
 * decide when to flip a graced subscription to enforced.
 */
export function isPastDueWithinGrace(
  pastDueAt: Date | null | undefined,
  graceMs: number,
  now: Date = new Date(),
): boolean {
  if (pastDueAt === null || pastDueAt === undefined) return false;
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
export function resolvePlan(
  subscription: Pick<
    SubscriptionRow,
    | "tier"
    | "status"
    | "staffCap"
    | "locationCap"
    | "productCap"
    | "orderCap"
    | "templateCap"
  > & { pastDueAt?: Date | null } | null,
  graceMs?: number,
): SubscriptionPlan {
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
  const row: Partial<
    Pick<SubscriptionRow, "staffCap" | "locationCap" | "productCap" | "orderCap" | "templateCap">
  > = {
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
    active:
      USABLE_STATUS.has(subscription.status) ||
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
export function checkCap(
  cap: number | null,
  count: number,
  resourceName: string,
  upgradePlan: string,
): { allowed: boolean; cap: number | null; message: string } {
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
