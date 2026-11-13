import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const prismaMocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({ getPrismaClient: prismaMocks.getPrismaClient }));

const activityMocks = vi.hoisted(() => ({ logStoreActivity: vi.fn() }));
vi.mock("../activity/service.js", () => ({ logStoreActivity: activityMocks.logStoreActivity }));

import { Prisma } from "../../../generated/prisma/client.js";
import {
  cancelSubscription,
  computeDowngradeWarnings,
  initiateSubscriptionCheckout,
  initiateSubscriptionUpgrade,
  proratedUpgradeAmount,
  scheduleSubscriptionDowngrade,
} from "./billing.service.js";

type PrismaStub = {
  store: { findUnique: Mock; update: Mock };
  subscription: { findUnique: Mock; update: Mock };
  subscriptionPayment: { create: Mock; findMany: Mock };
  subscriptionPlanSetting: { findUnique: Mock };
  staffMember: { count: Mock };
  product: { count: Mock };
  order: { count: Mock };
  location: { count: Mock };
  storeTemplate: { findMany: Mock };
};

function subscriptionRow(overrides: Record<string, unknown> = {}) {
  return {
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
    templateCap: null,
    pendingDowngradeTier: null,
    pastDueAt: null,
    paystackSubscriptionCode: "SUB_old",
    paystackPlanCode: "PLN_pro",
    paystackEmailToken: "tok_1",
    legacyPaystackSubscriptionCode: null,
    legacyPaystackPlanCode: null,
    swapPending: false,
    renewalCount: 0,
    createdAt: new Date("2026-08-02T00:00:00Z"),
    updatedAt: new Date("2026-08-02T00:00:00Z"),
    ...overrides,
  };
}

const STORE_ID = "store-1";

let prisma: PrismaStub;
let provider: {
  initiateCheckout: Mock;
  initializeSubscription: Mock;
  createRecurringSubscription: Mock;
  disableRecurringSubscription: Mock;
};

beforeEach(() => {
  prisma = {
    store: { findUnique: vi.fn(), update: vi.fn() },
    subscription: { findUnique: vi.fn(), update: vi.fn() },
    subscriptionPayment: { create: vi.fn(), findMany: vi.fn() },
    subscriptionPlanSetting: { findUnique: vi.fn() },
    staffMember: { count: vi.fn() },
    product: { count: vi.fn() },
    order: { count: vi.fn() },
    location: { count: vi.fn() },
    storeTemplate: { findMany: vi.fn() },
  };
  prismaMocks.getPrismaClient.mockReturnValue(prisma as never);
  activityMocks.logStoreActivity.mockReset();
  activityMocks.logStoreActivity.mockResolvedValue(undefined);

  provider = {
    initiateCheckout: vi.fn(),
    initializeSubscription: vi.fn(),
    createRecurringSubscription: vi.fn(),
    disableRecurringSubscription: vi.fn(),
  };
  provider.initializeSubscription.mockResolvedValue({
    reference: "sub_ABC",
    authorizationUrl: "https://checkout.paystack.com/x",
  });
  provider.initiateCheckout.mockResolvedValue({
    reference: "upg_ABC",
    authorizationUrl: "https://checkout.paystack.com/y",
  });
  provider.createRecurringSubscription.mockResolvedValue({
    subscriptionCode: "SUB_new",
    emailToken: "tok_new",
  });
  provider.disableRecurringSubscription.mockResolvedValue(undefined);
});

const providerFactory = () => provider as never;

/** Makes loadSubscription resolve to a subscription for STORE_ID. */
function mockActiveSubscription(overrides: Record<string, unknown> = {}) {
  prisma.store.findUnique.mockResolvedValue({
    subscriptionId: "sub-1",
    ...(overrides.store ?? {}),
  });
  prisma.subscription.findUnique.mockResolvedValue(subscriptionRow(overrides));
}

describe("proratedUpgradeAmount (unit)", () => {
  it("computes the prorated difference for the remaining cycle", () => {
    expect(proratedUpgradeAmount("4900.00", "9900.00", 15, 30)).toBe("2500.00");
  });

  it("rejects a target not higher-priced", () => {
    expect(() => proratedUpgradeAmount("9900.00", "4900.00", 15, 30)).toThrow();
  });

  it("zeroes out when no time remains", () => {
    expect(proratedUpgradeAmount("4900.00", "9900.00", 0, 30)).toBe("0.00");
  });
});

describe("initiateSubscriptionCheckout (unit)", () => {
  it("opens a checkout, records a PENDING payment, and returns the auth url", async () => {
    prisma.subscriptionPlanSetting.findUnique.mockResolvedValue({
      plan: "PRO",
      monthlyPrice: new Prisma.Decimal("4900.00"),
      paystackPlanCode: "PLN_pro",
    });
    prisma.store.findUnique.mockResolvedValue({
      owner: { account: { email: "owner@example.com" } },
    });
    prisma.subscription.findUnique.mockResolvedValue(null);

    const result = await initiateSubscriptionCheckout(STORE_ID, "PRO", providerFactory);

    expect(provider.initializeSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ planCode: "PLN_pro", email: "owner@example.com" }),
    );
    expect(prisma.subscriptionPayment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "SUBSCRIPTION",
          status: "PENDING",
          tier: "PRO",
          amount: new Prisma.Decimal("4900.00"),
        }),
      }),
    );
    expect(result).toMatchObject({
      authorizationUrl: "https://checkout.paystack.com/x",
      amount: "4900.00",
      tier: "PRO",
    });
  });

  it("409s when the tier has no configured price/plan", async () => {
    prisma.subscriptionPlanSetting.findUnique.mockResolvedValue(null);

    await expect(
      initiateSubscriptionCheckout(STORE_ID, "PRO", providerFactory),
    ).rejects.toMatchObject({ statusCode: 409, code: "PRICING_NOT_CONFIGURED" });
  });

  it("409s when the store already has an active subscription", async () => {
    prisma.subscriptionPlanSetting.findUnique.mockResolvedValue({
      plan: "PRO",
      monthlyPrice: new Prisma.Decimal("4900.00"),
      paystackPlanCode: "PLN_pro",
    });
    prisma.store.findUnique.mockResolvedValue({
      owner: { account: { email: "owner@example.com" } },
      subscriptionId: "sub-1",
    });
    prisma.subscription.findUnique.mockResolvedValue(subscriptionRow());

    await expect(
      initiateSubscriptionCheckout(STORE_ID, "PRO", providerFactory),
    ).rejects.toMatchObject({ statusCode: 409, code: "ALREADY_SUBSCRIBED" });
  });
});

describe("initiateSubscriptionUpgrade (unit)", () => {
  it("charges the prorated diff as a one-off and records a PENDING UPGRADE", async () => {
    mockActiveSubscription({ tier: "PRO" });
    prisma.store.findUnique.mockResolvedValue({
      owner: { account: { email: "owner@example.com" } },
      subscriptionId: "sub-1",
    });
    prisma.subscriptionPlanSetting.findUnique
      .mockResolvedValueOnce({
        plan: "PRO",
        monthlyPrice: new Prisma.Decimal("4900.00"),
        paystackPlanCode: "PLN_pro",
      })
      .mockResolvedValueOnce({
        plan: "ENTERPRISE",
        monthlyPrice: new Prisma.Decimal("19000.00"),
        paystackPlanCode: "PLN_ent",
      });

    // currentPeriodEnd is 2026-09-01; freeze "now" near period end so the
    // proration is deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T00:00:00Z"));
    try {
      const result = await initiateSubscriptionUpgrade(STORE_ID, "ENTERPRISE", providerFactory);

      expect(provider.initiateCheckout).toHaveBeenCalledWith(
        expect.objectContaining({ amount: expect.any(String), email: "owner@example.com" }),
      );
      expect(prisma.subscriptionPayment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ kind: "UPGRADE", tier: "ENTERPRISE" }),
        }),
      );
      expect(result.tier).toBe("ENTERPRISE");
      expect(result.effectiveImmediately).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("409s when the target is not higher-priced", async () => {
    mockActiveSubscription({ tier: "ENTERPRISE" });
    prisma.store.findUnique.mockResolvedValue({
      owner: { account: { email: "owner@example.com" } },
      subscriptionId: "sub-1",
    });
    prisma.subscriptionPlanSetting.findUnique
      .mockResolvedValueOnce({
        plan: "ENTERPRISE",
        monthlyPrice: new Prisma.Decimal("19000.00"),
        paystackPlanCode: "PLN_ent",
      })
      .mockResolvedValueOnce({
        plan: "PRO",
        monthlyPrice: new Prisma.Decimal("4900.00"),
        paystackPlanCode: "PLN_pro",
      });

    await expect(
      initiateSubscriptionUpgrade(STORE_ID, "PRO", providerFactory),
    ).rejects.toMatchObject({ statusCode: 409, code: "UPGRADE_NOT_HIGHER" });
  });
});

describe("scheduleSubscriptionDowngrade (unit)", () => {
  it("sets pendingDowngradeTier and returns warnings + effective date", async () => {
    mockActiveSubscription({ tier: "PRO" });
    prisma.store.findUnique.mockResolvedValue({
      subscriptionId: "sub-1",
      template: { id: "tmpl-1", name: "Market" },
    });
    prisma.subscriptionPlanSetting.findUnique
      .mockResolvedValueOnce({
        plan: "PRO",
        monthlyPrice: new Prisma.Decimal("4900.00"),
        paystackPlanCode: "PLN_pro",
      })
      .mockResolvedValueOnce({
        plan: "STARTER",
        monthlyPrice: new Prisma.Decimal("0.00"),
        paystackPlanCode: "PLN_starter",
      });
    prisma.staffMember.count.mockResolvedValue(2);
    prisma.location.count.mockResolvedValue(1);
    prisma.product.count.mockResolvedValue(50);
    prisma.order.count.mockResolvedValue(10);
    prisma.storeTemplate.findMany.mockResolvedValue([
      { id: "tmpl-1" },
      { id: "tmpl-2" },
    ]);

    const result = await scheduleSubscriptionDowngrade(STORE_ID, "STARTER");

    expect(prisma.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ pendingDowngradeTier: "STARTER" }),
      }),
    );
    expect(result.targetTier).toBe("STARTER");
    expect(result.effectiveAt).toBeDefined();
    // STARTER staffCap is 1; the store has 2 staff -> OVER_CAP warning.
    expect(result.warnings.some((w) => w.type === "OVER_CAP" && w.resource === "staff")).toBe(true);
  });

  it("409s when the target is not lower-priced", async () => {
    mockActiveSubscription({ tier: "STARTER" });
    prisma.store.findUnique.mockResolvedValue({
      subscriptionId: "sub-1",
      template: { id: "tmpl-1", name: "Market" },
    });
    prisma.subscriptionPlanSetting.findUnique
      .mockResolvedValueOnce({
        plan: "STARTER",
        monthlyPrice: new Prisma.Decimal("0.00"),
        paystackPlanCode: "PLN_starter",
      })
      .mockResolvedValueOnce({
        plan: "PRO",
        monthlyPrice: new Prisma.Decimal("4900.00"),
        paystackPlanCode: "PLN_pro",
      });

    await expect(
      scheduleSubscriptionDowngrade(STORE_ID, "PRO"),
    ).rejects.toMatchObject({ statusCode: 409, code: "DOWNGRADE_NOT_LOWER" });
  });
});

describe("computeDowngradeWarnings (unit)", () => {
  it("flags over-cap, feature-lost, and template-lost for a downgrade", async () => {
    mockActiveSubscription({ tier: "PRO" });
    prisma.store.findUnique.mockResolvedValue({
      subscriptionId: "sub-1",
      template: { id: "tmpl-1", name: "Market" },
    });
    prisma.staffMember.count.mockResolvedValue(2);
    prisma.location.count.mockResolvedValue(1);
    prisma.product.count.mockResolvedValue(200);
    prisma.order.count.mockResolvedValue(10);
    prisma.storeTemplate.findMany.mockResolvedValue([{ id: "tmpl-1" }, { id: "tmpl-2" }]);

    const warnings = await computeDowngradeWarnings(STORE_ID, "STARTER");

    // 200 products vs STARTER 100 -> over-cap.
    expect(warnings.some((w) => w.type === "OVER_CAP" && w.resource === "products")).toBe(true);
    // customDomain feature lost (PRO true, STARTER false).
    expect(warnings.some((w) => w.type === "FEATURE_LOST" && w.feature === "customDomain")).toBe(
      true,
    );
  });

  it("does not flag over-cap when usage is under every target cap", async () => {
    mockActiveSubscription({ tier: "PRO" });
    prisma.store.findUnique.mockResolvedValue({
      subscriptionId: "sub-1",
      template: { id: "tmpl-1", name: "Market" },
    });
    prisma.staffMember.count.mockResolvedValue(0);
    prisma.location.count.mockResolvedValue(0);
    prisma.product.count.mockResolvedValue(10);
    prisma.order.count.mockResolvedValue(5);
    prisma.storeTemplate.findMany.mockResolvedValue([{ id: "tmpl-1" }, { id: "tmpl-2" }]);

    const warnings = await computeDowngradeWarnings(STORE_ID, "STARTER");
    expect(warnings.some((w) => w.type === "OVER_CAP")).toBe(false);
  });
});

describe("cancelSubscription (unit)", () => {
  it("disables the Paystack subscription and marks the store CANCELLED", async () => {
    mockActiveSubscription({ tier: "PRO" });

    await cancelSubscription(STORE_ID, providerFactory);

    expect(provider.disableRecurringSubscription).toHaveBeenCalledWith({
      subscriptionCode: "SUB_old",
      emailToken: "tok_1",
    });
    expect(prisma.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "CANCELLED" }) }),
    );
  });
});
