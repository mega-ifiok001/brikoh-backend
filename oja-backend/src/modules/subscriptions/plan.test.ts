import { describe, expect, it } from "vitest";
import { TIER_PLANS, resolvePlan, checkCap } from "./plan.js";
import type { SubscriptionPlan } from "./plan.js";

describe("TIER_PLANS (unit)", () => {
  it("gives ENTERPRISE unlimited caps (null) and all features", () => {
    expect(TIER_PLANS.ENTERPRISE.limits).toEqual({
      staffCap: null,
      locationCap: null,
      productCap: null,
      orderCap: null,
      templateCap: null,
    });
    expect(TIER_PLANS.ENTERPRISE.featureFlags).toEqual({
      customDomain: true,
      advancedAnalytics: true,
      marketingTools: true,
    });
  });

  it("keeps customDomain off STARTER but on PRO", () => {
    expect(TIER_PLANS.STARTER.featureFlags.customDomain).toBe(false);
    expect(TIER_PLANS.PRO.featureFlags.customDomain).toBe(true);
    expect(TIER_PLANS.PRO.featureFlags.marketingTools).toBe(false);
  });

  it("orders caps STARTER < PRO", () => {
    expect(TIER_PLANS.STARTER.limits.productCap).toBe(100);
    expect(TIER_PLANS.PRO.limits.productCap).toBe(500);
  });
});

describe("resolvePlan (unit)", () => {
  function sub(overrides: Record<string, unknown> = {}): Parameters<typeof resolvePlan>[0] {
    return {
      tier: "PRO",
      status: "ACTIVE",
      staffCap: null,
      locationCap: null,
      productCap: null,
      orderCap: null,
      templateCap: null,
      ...overrides,
    };
  }

  it("maps an ACTIVE PRO subscription to the PRO tiers + is usable", () => {
    const plan = resolvePlan(sub({ tier: "PRO", status: "ACTIVE" }));
    expect(plan.tier).toBe("PRO");
    expect(plan.status).toBe("ACTIVE");
    expect(plan.active).toBe(true);
    expect(plan.limits).toEqual(TIER_PLANS.PRO.limits);
    expect(plan.featureFlags).toEqual(TIER_PLANS.PRO.featureFlags);
  });

  it("treats TRIALING as usable (active=true)", () => {
    expect(resolvePlan(sub({ status: "TRIALING" })).active).toBe(true);
  });

  it("treats PAST_DUE and CANCELLED as inactive", () => {
    expect(resolvePlan(sub({ status: "PAST_DUE" })).active).toBe(false);
    expect(resolvePlan(sub({ status: "CANCELLED" })).active).toBe(false);
  });

  it("returns unlimited (null) caps for a store with no subscription", () => {
    const plan = resolvePlan(null);
    expect(plan.tier).toBe("STARTER");
    expect(plan.status).toBe(null);
    expect(plan.active).toBe(false);
    expect(plan.limits).toEqual({
      staffCap: null,
      locationCap: null,
      productCap: null,
      orderCap: null,
      templateCap: null,
    });
    expect(plan.featureFlags).toEqual({
      customDomain: false,
      advancedAnalytics: false,
      marketingTools: false,
    });
  });

  it("lets a non-null row cap override the tier default", () => {
    const plan = resolvePlan(
      sub({ tier: "STARTER", status: "ACTIVE", productCap: 25, orderCap: 7, templateCap: 2 }),
    );
    expect(plan.limits.productCap).toBe(25);
    expect(plan.limits.orderCap).toBe(7);
    expect(plan.limits.templateCap).toBe(2);
    // unset caps keep the tier default
    expect(plan.limits.staffCap).toBe(TIER_PLANS.STARTER.limits.staffCap);
  });
});

describe("checkCap (unit) — the inequality direction", () => {
  it("allows under (count < cap)", () => {
    expect(checkCap(2, 1, "product", "PRO")).toMatchObject({ allowed: true, cap: 2 });
  });

  it("rejects exactly at (count == cap) — the edge case", () => {
    const result = checkCap(2, 2, "product", "PRO");
    expect(result.allowed).toBe(false);
    expect(result.cap).toBe(2);
    expect(result.message).toContain("2");
    expect(result.message).toContain("PRO");
  });

  it("rejects over (count > cap)", () => {
    expect(checkCap(2, 3, "product", "PRO")).toMatchObject({ allowed: false, cap: 2 });
  });

  it("allows everything when the cap is null (unlimited)", () => {
    expect(checkCap(null, 99_999, "product", "PRO")).toMatchObject({ allowed: true, cap: null });
  });
});

describe("resolvePlan type surface (unit)", () => {
  it("returns the documented plan shape (compile-time contract)", () => {
    const plan: SubscriptionPlan = resolvePlan(null);
    expect(Object.keys(plan)).toEqual(
      expect.arrayContaining(["tier", "status", "active", "limits", "featureFlags"]),
    );
    expect(Object.keys(plan.limits)).toEqual(
      expect.arrayContaining(["staffCap", "locationCap", "productCap", "orderCap", "templateCap"]),
    );
    expect(Object.keys(plan.featureFlags)).toEqual(
      expect.arrayContaining(["customDomain", "advancedAnalytics", "marketingTools"]),
    );
  });
});
