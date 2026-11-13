import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const prismaMocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({ getPrismaClient: prismaMocks.getPrismaClient }));

import { env } from "../../config/env.js";
import type { PaymentProvider } from "../../lib/paymentProvider.js";
import { handlePaystackSubscriptionWebhook } from "./subscriptionWebhook.service.js";

type TxStub = {
  webhookEvent: { create: Mock; updateMany: Mock };
  subscription: {
    create: Mock;
    update: Mock;
    updateMany: Mock;
    findFirst: Mock;
    findUnique: Mock;
  };
  subscriptionPayment: {
    findUnique: Mock;
    update: Mock;
    updateMany: Mock;
    create: Mock;
  };
  subscriptionPlanSetting: { findUnique: Mock };
  store: { findUnique: Mock; update: Mock };
};

type PrismaStub = {
  webhookEvent: { findUnique: Mock };
  subscriptionPayment: { findUnique: Mock };
  subscription: { findFirst: Mock };
  $transaction: Mock;
};

const STORE_ID = "store-1";

function createTxStub(): TxStub {
  return {
    webhookEvent: { create: vi.fn(), updateMany: vi.fn() },
    subscription: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    subscriptionPayment: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    subscriptionPlanSetting: { findUnique: vi.fn() },
    store: { findUnique: vi.fn(), update: vi.fn() },
  };
}

function createPrismaStub(): PrismaStub {
  return {
    webhookEvent: { findUnique: vi.fn() },
    subscriptionPayment: { findUnique: vi.fn() },
    subscription: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  };
}

let tx: TxStub;
let prisma: PrismaStub;
let provider: { verifyWebhookSignature: Mock };

function sign(rawBody: Buffer): string {
  return createHmac("sha512", env.PLATFORM_PAYSTACK_SECRET_KEY).update(rawBody).digest("hex");
}

function payload(event: string, data: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify({ event, data: { id: `evt_${Math.random()}`, ...data } }));
}

beforeEach(() => {
  tx = createTxStub();
  prisma = createPrismaStub();
  prismaMocks.getPrismaClient.mockReturnValue(prisma as never);
  prisma.$transaction.mockImplementation(async (fn: (t: TxStub) => Promise<unknown>) => fn(tx));
  prisma.webhookEvent.findUnique.mockResolvedValue(null);

  provider = { verifyWebhookSignature: vi.fn(async () => true) };
  const providerFactory = () => ({ ...provider }) as unknown as PaymentProvider;
  vi.stubGlobal("__providerFactory", providerFactory);
});

function subscriptionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    storeId: STORE_ID,
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
    paystackSubscriptionCode: "SUB_current",
    paystackPlanCode: "PLN_pro",
    paystackEmailToken: "tok_1",
    legacyPaystackSubscriptionCode: null,
    legacyPaystackPlanCode: null,
    swapPending: false,
    renewalCount: 1,
    createdAt: new Date("2026-08-02T00:00:00Z"),
    updatedAt: new Date("2026-08-02T00:00:00Z"),
    ...overrides,
  };
}

describe("handlePaystackSubscriptionWebhook (unit)", () => {
  it("ignores unknown event types without writing anything", async () => {
    const raw = payload("random.event", {});
    const result = await handlePaystackSubscriptionWebhook(raw, sign(raw), () =>
      ({ verifyWebhookSignature: provider.verifyWebhookSignature }) as never,
    );
    expect(result.outcome).toBe("IGNORED");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects a bad signature with 401", async () => {
    const raw = payload("charge.success", { reference: "sub_X" });
    provider.verifyWebhookSignature.mockResolvedValue(false);
    await expect(
      handlePaystackSubscriptionWebhook(raw, "deadbeef", () =>
        ({ verifyWebhookSignature: provider.verifyWebhookSignature }) as never,
      ),
    ).rejects.toMatchObject({ statusCode: 401, code: "INVALID_SIGNATURE" });
  });

  it("returns DUPLICATE when the event was already seen", async () => {
    prisma.webhookEvent.findUnique.mockResolvedValue({ id: "evt" });
    const raw = payload("charge.success", { reference: "sub_X" });
    const result = await handlePaystackSubscriptionWebhook(raw, sign(raw), () =>
      ({ verifyWebhookSignature: provider.verifyWebhookSignature }) as never,
    );
    expect(result.outcome).toBe("DUPLICATE");
  });

  it("activates a subscription on the first charge.success (SUBSCRIPTION payment)", async () => {
    const raw = payload("charge.success", {
      reference: "sub_ABC",
      plan: { plan_code: "PLN_pro" },
      subscription: { subscription_code: "SUB_current", email_token: "tok_1" },
      amount: 490000,
    });
    const paymentRow = {
      id: "pay-1",
      storeId: STORE_ID,
      tier: "PRO",
      kind: "SUBSCRIPTION",
      status: "PENDING",
      reference: "sub_ABC",
    };
    prisma.subscriptionPayment.findUnique.mockResolvedValue(paymentRow);
    tx.subscriptionPayment.findUnique.mockResolvedValue(paymentRow);
    prisma.subscription.findFirst.mockResolvedValue(null);
    tx.subscription.findFirst.mockResolvedValue(null);
    tx.store.findUnique.mockResolvedValue({ subscriptionId: null });
    tx.subscription.create.mockResolvedValue({ id: "sub-new" });
    tx.store.update.mockResolvedValue({ id: STORE_ID });
    tx.subscriptionPayment.update.mockResolvedValue({});

    const result = await handlePaystackSubscriptionWebhook(raw, sign(raw), () =>
      ({ verifyWebhookSignature: provider.verifyWebhookSignature }) as never,
    );

    expect(result.outcome).toBe("PROCESSED");
    expect(tx.subscription.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ storeId: STORE_ID, tier: "PRO" }) }),
    );
    expect(tx.store.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { subscriptionId: "sub-new" } }),
    );
    expect(tx.subscriptionPayment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "PAID" }) }),
    );
  });

  it("rolls the period + bumps renewalCount on a renewal within the same code", async () => {
    const raw = payload("charge.success", {
      plan: { plan_code: "PLN_pro" },
      subscription: { subscription_code: "SUB_current" },
      amount: 490000,
    });
    prisma.subscriptionPayment.findUnique.mockResolvedValue(null);
    prisma.subscription.findFirst.mockResolvedValue(subscriptionRow());
    tx.store.findUnique.mockResolvedValue({ subscriptionId: "sub-1" });
    tx.subscription.findUnique.mockResolvedValue(subscriptionRow({
      currentPeriodEnd: new Date("2026-08-01T00:00:00Z"),
    }));
    tx.subscription.findFirst.mockResolvedValue(subscriptionRow({
      currentPeriodEnd: new Date("2026-08-01T00:00:00Z"),
    }));
    tx.subscription.create.mockResolvedValue({ id: "sub-new" });
    tx.subscriptionPayment.create.mockResolvedValue({});
    tx.subscription.update.mockResolvedValue({});

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T00:00:00Z"));
    try {
      const result = await handlePaystackSubscriptionWebhook(raw, sign(raw), () =>
        ({ verifyWebhookSignature: provider.verifyWebhookSignature }) as never,
      );
      expect(result.outcome).toBe("PROCESSED");
      // The current period (ends 2026-08-01) is in the past -> roll it.
      expect(tx.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ renewalCount: { increment: 1 } }),
        }),
      );
      expect(tx.subscriptionPayment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ kind: "RENEWAL", status: "PAID" }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("records an orphan payment (Guard 1) when the old subscription charges after an upgrade", async () => {
    const raw = payload("charge.success", {
      reference: "sub_OLD",
      plan: { plan_code: "PLN_pro" },
      subscription: { subscription_code: "SUB_legacy" },
      amount: 490000,
    });
    const paymentRow = {
      id: "pay-1",
      storeId: STORE_ID,
      tier: "PRO",
      kind: "SUBSCRIPTION",
      status: "PENDING",
      reference: "sub_OLD",
    };
    prisma.subscriptionPayment.findUnique.mockResolvedValue(paymentRow);
    tx.subscriptionPayment.findUnique.mockResolvedValue(paymentRow);
    tx.subscription.findFirst.mockResolvedValue(subscriptionRow({
      legacyPaystackSubscriptionCode: "SUB_legacy",
      legacyPaystackPlanCode: "PLN_pro",
      paystackSubscriptionCode: "SUB_new",
    }));
    tx.subscriptionPayment.update.mockResolvedValue({});

    const result = await handlePaystackSubscriptionWebhook(raw, sign(raw), () =>
      ({ verifyWebhookSignature: provider.verifyWebhookSignature }) as never,
    );

    expect(result.outcome).toBe("PROCESSED");
    // The payment is marked PAID with an orphan reason and NO subscription
    // activation/roll happened.
    const updateCall = tx.subscriptionPayment.update.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(updateCall.data.status).toBe("PAID");
    expect(updateCall.data.orphanReason).toContain("upgrade switch");
    expect(tx.subscription.create).not.toHaveBeenCalled();
    expect(tx.subscription.update).not.toHaveBeenCalled();
  });

  it("marks the subscription PAST_DUE on a failed renewal", async () => {
    const raw = payload("invoice.payment_failed", {
      subscription: { subscription_code: "SUB_current" },
    });
    prisma.subscription.findFirst.mockResolvedValue(subscriptionRow());
    tx.webhookEvent.create.mockResolvedValue({});
    tx.subscription.updateMany.mockResolvedValue({ count: 1 });

    const result = await handlePaystackSubscriptionWebhook(raw, sign(raw), () =>
      ({ verifyWebhookSignature: provider.verifyWebhookSignature }) as never,
    );

    expect(result.outcome).toBe("PROCESSED");
    expect(tx.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "PAST_DUE" }) }),
    );
  });

  it("captures the email token on subscription.create", async () => {
    const raw = payload("subscription.create", {
      subscription_code: "SUB_current",
      email_token: "tok_new",
    });
    prisma.subscription.findFirst.mockResolvedValue(subscriptionRow());
    tx.webhookEvent.create.mockResolvedValue({});
    tx.subscription.updateMany.mockResolvedValue({ count: 1 });

    const result = await handlePaystackSubscriptionWebhook(raw, sign(raw), () =>
      ({ verifyWebhookSignature: provider.verifyWebhookSignature }) as never,
    );

    expect(result.outcome).toBe("PROCESSED");
    expect(tx.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { paystackSubscriptionCode: "SUB_current" },
        data: { paystackEmailToken: "tok_new" },
      }),
    );
  });

  it("marks the subscription CANCELLED on subscription.disable", async () => {
    const raw = payload("subscription.disable", {
      subscription_code: "SUB_current",
    });
    prisma.subscription.findFirst.mockResolvedValue(subscriptionRow());
    tx.webhookEvent.create.mockResolvedValue({});
    tx.subscription.updateMany.mockResolvedValue({ count: 1 });

    const result = await handlePaystackSubscriptionWebhook(raw, sign(raw), () =>
      ({ verifyWebhookSignature: provider.verifyWebhookSignature }) as never,
    );

    expect(result.outcome).toBe("PROCESSED");
    expect(tx.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "CANCELLED" }) }),
    );
  });
});
