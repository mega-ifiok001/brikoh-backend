import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const prismaMocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({ getPrismaClient: prismaMocks.getPrismaClient }));

import {
  getPlan,
  getUsageAgainstLimits,
  requireActiveSubscription,
  setCustomDomain,
} from "./service.js";
import { Prisma } from "../../../generated/prisma/client.js";

type PrismaStub = {
  store: { findUnique: Mock; update: Mock };
  subscription: { findUnique: Mock };
  staffMember: { count: Mock };
  product: { count: Mock };
  order: { count: Mock };
  location: { count: Mock };
};

function createStoreStub(overrides: Record<string, unknown> = {}): PrismaStub {
  return {
    store: { findUnique: vi.fn(), update: vi.fn() },
    subscription: { findUnique: vi.fn() },
    staffMember: { count: vi.fn() },
    product: { count: vi.fn() },
    order: { count: vi.fn() },
    location: { count: vi.fn() },
    ...overrides,
  };
}

function subscriptionRow(overrides: Record<string, unknown> = {}) {
  const base = {
    id: "sub-1",
    storeId: "store-1",
    tier: "PRO",
    status: "ACTIVE",
    currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
    currentPeriodStart: new Date("2026-08-02T00:00:00Z"),
    staffCap: null,
    locationCap: null,
    productCap: null,
    orderCap: null,
    createdAt: new Date("2026-08-02T00:00:00Z"),
    updatedAt: new Date("2026-08-02T00:00:00Z"),
  };
  return { ...base, ...overrides } as unknown as
    Parameters<typeof vi.fn>[number] | Record<string, unknown>;
}

const STORE_ID = "store-1";

let prisma: PrismaStub;

beforeEach(() => {
  prisma = createStoreStub();
  prismaMocks.getPrismaClient.mockReturnValue(prisma);
});

describe("getPlan (unit)", () => {
  it("returns the unlimited STARTER view when the store has no subscription", async () => {
    prisma.store.findUnique.mockResolvedValue({ id: STORE_ID, subscriptionId: null });

    const plan = await getPlan(STORE_ID);

    expect(plan).toMatchObject({
      tier: "STARTER",
      status: null,
      active: false,
      limits: { staffCap: null, locationCap: null, productCap: null, orderCap: null },
    });
    expect(plan?.featureFlags.customDomain).toBe(false);
  });

  it("resolves the tier + limits + flags from an active subscription", async () => {
    prisma.store.findUnique.mockResolvedValue({ id: STORE_ID, subscriptionId: "sub-1" });
    prisma.subscription.findUnique.mockResolvedValue(
      subscriptionRow({ tier: "PRO", status: "ACTIVE" }),
    );

    const plan = await getPlan(STORE_ID);

    expect(plan).toMatchObject({ tier: "PRO", status: "ACTIVE", active: true });
    expect(plan?.limits.productCap).toBe(500);
    expect(plan?.featureFlags.customDomain).toBe(true);
  });

  it("honours a non-null row cap overriding the tier default", async () => {
    prisma.store.findUnique.mockResolvedValue({ id: STORE_ID, subscriptionId: "sub-1" });
    prisma.subscription.findUnique.mockResolvedValue(
      subscriptionRow({ tier: "STARTER", status: "ACTIVE", productCap: 25 }),
    );

    const plan = await getPlan(STORE_ID);
    expect(plan?.limits.productCap).toBe(25);
    expect(plan?.limits.staffCap).toBe(1); // tier default preserved
  });
});

describe("requireActiveSubscription (unit)", () => {
  it("resolves the plan when the subscription is ACTIVE", async () => {
    prisma.store.findUnique.mockResolvedValue({ id: STORE_ID, subscriptionId: "sub-1" });
    prisma.subscription.findUnique.mockResolvedValue(subscriptionRow({ status: "ACTIVE" }));

    const plan = await requireActiveSubscription(STORE_ID);
    expect(plan.active).toBe(true);
  });

  it("allows TRIALING through", async () => {
    prisma.store.findUnique.mockResolvedValue({ id: STORE_ID, subscriptionId: "sub-1" });
    prisma.subscription.findUnique.mockResolvedValue(subscriptionRow({ status: "TRIALING" }));

    const plan = await requireActiveSubscription(STORE_ID);
    expect(plan.active).toBe(true);
  });

  it("throws 403 SUBSCRIPTION_INACTIVE when there is no subscription", async () => {
    prisma.store.findUnique.mockResolvedValue({ id: STORE_ID, subscriptionId: null });

    await expect(requireActiveSubscription(STORE_ID)).rejects.toMatchObject({
      statusCode: 403,
      code: "SUBSCRIPTION_INACTIVE",
    });
  });

  it("throws 403 SUBSCRIPTION_INACTIVE when the subscription is PAST_DUE", async () => {
    prisma.store.findUnique.mockResolvedValue({ id: STORE_ID, subscriptionId: "sub-1" });
    prisma.subscription.findUnique.mockResolvedValue(subscriptionRow({ status: "PAST_DUE" }));

    await expect(requireActiveSubscription(STORE_ID)).rejects.toMatchObject({
      statusCode: 403,
      code: "SUBSCRIPTION_INACTIVE",
    });
  });

  it("throws 403 SUBSCRIPTION_INACTIVE when the subscription is CANCELLED", async () => {
    prisma.store.findUnique.mockResolvedValue({ id: STORE_ID, subscriptionId: "sub-1" });
    prisma.subscription.findUnique.mockResolvedValue(subscriptionRow({ status: "CANCELLED" }));

    await expect(requireActiveSubscription(STORE_ID)).rejects.toMatchObject({
      statusCode: 403,
      code: "SUBSCRIPTION_INACTIVE",
    });
  });
});

describe("getUsageAgainstLimits (unit)", () => {
  it("counts staff, products, and period-windowed orders for an active subscription", async () => {
    prisma.store.findUnique.mockResolvedValue({ id: STORE_ID, subscriptionId: "sub-1" });
    prisma.subscription.findUnique.mockResolvedValue(
      subscriptionRow({
        tier: "PRO",
        status: "ACTIVE",
        currentPeriodStart: new Date("2026-08-02T00:00:00Z"),
        currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
      }),
    );
    prisma.staffMember.count.mockResolvedValue(3);
    prisma.location.count.mockResolvedValue(1);
    prisma.product.count.mockResolvedValue(8);
    prisma.order.count.mockResolvedValue(47);

    const result = await getUsageAgainstLimits(STORE_ID, { customDomain: "shop.example.com" });

    expect(prisma.order.count).toHaveBeenCalledWith({
      where: {
        storeId: STORE_ID,
        createdAt: { gte: new Date("2026-08-02T00:00:00Z"), lt: new Date("2026-09-01T00:00:00Z") },
      },
    });
    expect(result).toMatchObject({
      plan: { tier: "PRO", active: true, limits: { staffCap: 10, orderCap: 5000 } },
      usage: { staff: 3, locations: 1, products: 8, orders: 47 },
      period: { start: "2026-08-02T00:00:00.000Z", end: "2026-09-01T00:00:00.000Z" },
    });
  });

  it("falls back to a 30-day window when currentPeriodStart is null", async () => {
    prisma.store.findUnique.mockResolvedValue({ id: STORE_ID, subscriptionId: "sub-1" });
    const end = new Date("2026-09-01T00:00:00Z");
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 30); // currentPeriodEnd - 30 days
    prisma.subscription.findUnique.mockResolvedValue(
      subscriptionRow({
        tier: "PRO",
        status: "ACTIVE",
        currentPeriodStart: null,
        currentPeriodEnd: end,
      }),
    );
    prisma.staffMember.count.mockResolvedValue(0);
    prisma.location.count.mockResolvedValue(0);
    prisma.product.count.mockResolvedValue(0);
    prisma.order.count.mockResolvedValue(5);

    const result = await getUsageAgainstLimits(STORE_ID, { customDomain: null });

    expect(prisma.order.count).toHaveBeenCalledWith({
      where: { storeId: STORE_ID, createdAt: { gte: start, lt: end } },
    });
    expect(result.period).toEqual({ start: start.toISOString(), end: end.toISOString() });
  });

  it("includes the store customDomain when present", async () => {
    prisma.store.findUnique.mockResolvedValue({
      id: STORE_ID,
      subscriptionId: null,
      customDomain: "shop.example.com",
    });
    prisma.staffMember.count.mockResolvedValue(0);
    prisma.product.count.mockResolvedValue(0);
    prisma.order.count.mockResolvedValue(0);

    const result = await getUsageAgainstLimits(STORE_ID, { customDomain: "shop.example.com" });
    expect(result.plan.active).toBe(false);
    expect(result.usage.orders).toBe(0);
    expect(result.customDomain).toBe("shop.example.com");
  });
});

describe("setCustomDomain (unit)", () => {
  function attachActivePro() {
    prisma.store.findUnique.mockResolvedValue({ id: STORE_ID, subscriptionId: "sub-1" });
    prisma.subscription.findUnique.mockResolvedValue(
      subscriptionRow({ tier: "PRO", status: "ACTIVE" }),
    );
    prisma.store.update.mockResolvedValue({ id: STORE_ID, customDomain: "shop.example.com" });
  }

  it("writes the domain when the tier includes the feature flag", async () => {
    attachActivePro();

    const result = await setCustomDomain(STORE_ID, "shop.example.com");

    expect(prisma.store.update).toHaveBeenCalledWith({
      where: { id: STORE_ID },
      data: { customDomain: "shop.example.com" },
    });
    expect(result).toEqual({ customDomain: "shop.example.com" });
  });

  it("rejects with 403 PLAN_FEATURE_LOCKED when the tier lacks the flag (direct API bypass)", async () => {
    prisma.store.findUnique.mockResolvedValue({ id: STORE_ID, subscriptionId: "sub-1" });
    prisma.subscription.findUnique.mockResolvedValue(
      subscriptionRow({ tier: "STARTER", status: "ACTIVE" }),
    );

    await expect(setCustomDomain(STORE_ID, "shop.example.com")).rejects.toMatchObject({
      statusCode: 403,
      code: "PLAN_FEATURE_LOCKED",
    });
    expect(prisma.store.update).not.toHaveBeenCalled();
  });

  it("rejects with 403 SUBSCRIPTION_INACTIVE when the store has no subscription", async () => {
    prisma.store.findUnique.mockResolvedValue({ id: STORE_ID, subscriptionId: null });

    await expect(setCustomDomain(STORE_ID, "shop.example.com")).rejects.toMatchObject({
      statusCode: 403,
      code: "SUBSCRIPTION_INACTIVE",
    });
    expect(prisma.store.update).not.toHaveBeenCalled();
  });

  it("rejects with 409 CUSTOM_DOMAIN_TAKEN when another store owns the domain", async () => {
    attachActivePro();
    prisma.store.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "7.9.1",
      }),
    );

    await expect(setCustomDomain(STORE_ID, "shop.example.com")).rejects.toMatchObject({
      statusCode: 409,
      code: "CUSTOM_DOMAIN_TAKEN",
    });
  });
});
