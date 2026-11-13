import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({
  getPrismaClient: prismaMocks.getPrismaClient,
}));

import { Prisma } from "../../../generated/prisma/client.js";
import { PaymentProviderError } from "../../lib/paymentProvider.js";
import type { CheckoutInitiationInput, PaymentProvider } from "../../lib/paymentProvider.js";
import { decryptSecret, encryptSecret } from "../../lib/secrets.js";
import { generatePaymentReference, initiateCheckout, type CheckoutResult } from "./service.js";

type Mock = ReturnType<typeof vi.fn>;

interface TxStub {
  store: { update: Mock };
  order: { create: Mock };
  orderLineItem: { createMany: Mock };
  discount: { findUnique: Mock };
  couponRedemption: { count: Mock; create: Mock };
}

interface PrismaStub {
  $transaction: Mock;
  store: { findUnique: Mock };
  subscription: { findUnique: Mock };
  product: { findMany: Mock };
  productVariant: { findMany: Mock };
  branchStock: { findMany: Mock };
  paymentCredential: { findUnique: Mock };
  deliveryOption: { count: Mock };
  customer: { findFirst: Mock; create: Mock };
  customerGroup: { findFirst: Mock; create: Mock };
  discount: { findFirst: Mock };
  order: { update: Mock; count: Mock };
}

const STORE_ID = "store-1";
const BRANCH_ID = "branch-1";
const SECRET_KEY = "sk_test_1234abcd5678efgh";

function createPrismaStub(): PrismaStub {
  return {
    $transaction: vi.fn(async (fn: (tx: TxStub) => Promise<unknown>) => fn(createTxStub())),
    store: {
      findUnique: vi.fn().mockResolvedValue({
        id: STORE_ID,
        subscriptionId: null,
        defaultBranchId: BRANCH_ID,
      }),
    },
    subscription: { findUnique: vi.fn().mockResolvedValue(null) },
    product: { findMany: vi.fn() },
    productVariant: { findMany: vi.fn().mockResolvedValue([]) },
    branchStock: { findMany: vi.fn().mockResolvedValue([]) },
    paymentCredential: { findUnique: vi.fn() },
    deliveryOption: { count: vi.fn().mockResolvedValue(0) },
    customer: { findFirst: vi.fn(), create: vi.fn() },
    customerGroup: {
      findFirst: vi.fn().mockResolvedValue({ id: "group-general" }),
      create: vi.fn(),
    },
    discount: { findFirst: vi.fn() },
    order: { update: vi.fn(), count: vi.fn() },
  };
}

function createTxStub(): TxStub {
  return {
    store: { update: vi.fn().mockResolvedValue({ orderCounter: 1 }) },
    discount: {
      findUnique: vi.fn().mockResolvedValue({
        id: "discount-1",
        storeId: STORE_ID,
        maxUses: null,
        perCustomerUses: null,
        minSubtotal: null,
        firstOrderOnly: null,
      }),
    },
    couponRedemption: { count: vi.fn().mockResolvedValue(0), create: vi.fn() },
    order: { create: vi.fn() },
    orderLineItem: { createMany: vi.fn() },
  };
}

function productRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "product-1",
    storeId: STORE_ID,
    name: "Bottle",
    price: new Prisma.Decimal("9.99"),
    quantity: 10,
    deletedAt: null,
    variants: [],
    ...overrides,
  };
}

function variantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "variant-1",
    storeId: STORE_ID,
    productId: "product-1",
    name: "500ml",
    sellingPrice: new Prisma.Decimal("11.99"),
    sku: null,
    quantity: 5,
    createdAt: new Date("2026-08-01T10:00:00.000Z"),
    updatedAt: new Date("2026-08-01T10:00:00.000Z"),
    ...overrides,
  };
}

function credentialRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cred-1",
    storeId: STORE_ID,
    provider: "paystack",
    publicKey: "pk_test_1234",
    secretKeyEncrypted: encryptSecret(SECRET_KEY),
    ...overrides,
  };
}

function branchStockRow(
  productId: string,
  variantId: string | null,
  quantity: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    productId,
    variantId,
    quantity,
    ...overrides,
  };
}

function subscriptionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    storeId: STORE_ID,
    tier: "STARTER",
    status: "ACTIVE",
    currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
    currentPeriodStart: new Date("2026-08-02T00:00:00Z"),
    staffCap: null,
    locationCap: null,
    productCap: null,
    orderCap: 2,
    createdAt: new Date("2026-08-02T00:00:00Z"),
    updatedAt: new Date("2026-08-02T00:00:00Z"),
    ...overrides,
  };
}

function checkoutBody(overrides: Record<string, unknown> = {}) {
  return {
    customer: { name: "Ade Buyer", email: "buyer@example.com", phone: "08012345678" },
    items: [{ productId: "product-1", quantity: 2 }],
    ...overrides,
  };
}

let prisma: PrismaStub;
let tx: TxStub;
let provider: PaymentProvider & { initiateCheckout: Mock };

beforeEach(() => {
  prisma = createPrismaStub();
  tx = createTxStub();
  prismaMocks.getPrismaClient.mockReturnValue(prisma);
  prisma.$transaction.mockImplementation(async (fn: (t: TxStub) => Promise<unknown>) => fn(tx));
  tx.order.create.mockImplementation(async ({ data }: { data: { total: Prisma.Decimal } }) => ({
    id: "order-1",
    orderNumber: "ORD-0001",
    storeId: STORE_ID,
    customerId: "customer-1",
    status: "PENDING",
    total: data.total,
    paymentProvider: "paystack",
    paymentReference: "ord_ref_1",
  }));
  provider = {
    id: "paystack",
    initiateCheckout: vi.fn(async () => ({
      reference: "ord_ref_1",
      authorizationUrl: "https://checkout.paystack.test/session",
      accessCode: "access-1",
    })),
    verifyWebhookSignature: vi.fn(),
    getTransactionStatus: vi.fn(),
    resolveBankAccount: vi.fn(),
    createTransferRecipient: vi.fn(),
    initiateTransfer: vi.fn(),
    verifyTransfer: vi.fn(),
  };
});

const providerFactory = (creds: { publicKey: string; secretKey: string }): PaymentProvider => {
  expect(creds.publicKey).toBe("pk_test_1234");
  expect(creds.secretKey).toBe(SECRET_KEY);
  return provider;
};

async function setupHappy() {
  prisma.product.findMany.mockResolvedValue([productRow()]);
  prisma.branchStock.findMany.mockResolvedValue([
    branchStockRow("product-1", null, (productRow() as { quantity: number }).quantity),
  ]);
  prisma.paymentCredential.findUnique.mockResolvedValue(credentialRow());
  prisma.customer.findFirst.mockResolvedValue(null);
  prisma.customer.create.mockResolvedValue({ id: "customer-1" });
  prisma.order.update.mockResolvedValue({});
}

describe("generatePaymentReference (unit)", () => {
  it("produces a unique BRK-prefixed reference", () => {
    const first = generatePaymentReference();
    const second = generatePaymentReference();

    expect(first).toMatch(/^BRK-[A-Z0-9]{10}$/);
    expect(second).not.toBe(first);
  });
});

describe("initiateCheckout (unit) — happy path", () => {
  it("creates a PENDING order with captured prices, calls the provider, returns redirect", async () => {
    await setupHappy();

    const result = await initiateCheckout(STORE_ID, checkoutBody(), providerFactory);

    expect(prisma.customer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          storeId: STORE_ID,
          name: "Ade Buyer",
          email: "buyer@example.com",
          phone: "08012345678",
          source: "STOREFRONT",
          groupId: "group-general",
        },
      }),
    );
    expect(tx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          storeId: STORE_ID,
          customerId: "customer-1",
          status: "PENDING",
          paymentProvider: "paystack",
        }),
      }),
    );
    const orderCreateData = tx.order.create.mock.calls[0]![0].data as { total: Prisma.Decimal };
    expect(orderCreateData.total.toString()).toBe("19.98");
    expect(tx.orderLineItem.createMany).toHaveBeenCalledWith({
      data: [
        {
          storeId: STORE_ID,
          orderId: "order-1",
          productId: "product-1",
          variantId: null,
          quantity: 2,
          unitPriceAtPurchase: expect.any(Prisma.Decimal),
        },
      ],
    });
    const lineItem = tx.orderLineItem.createMany.mock.calls[0]![0].data[0] as {
      unitPriceAtPurchase: Prisma.Decimal;
    };
    expect(lineItem.unitPriceAtPurchase.toString()).toBe("9.99");

    const input = provider.initiateCheckout.mock.calls[0]![0] as CheckoutInitiationInput;
    const generatedReference = tx.order.create.mock.calls[0]![0].data.paymentReference as string;
    expect(input).toMatchObject({
      amount: "19.98",
      currency: "NGN",
      email: "buyer@example.com",
      reference: generatedReference,
    });

    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { authorizationUrl: "https://checkout.paystack.test/session" },
      }),
    );
    expect(result).toMatchObject({
      order: { id: "order-1", total: "19.98", status: "PENDING" },
      payment: {
        provider: "paystack",
        redirectUrl: "https://checkout.paystack.test/session",
      },
    });
    expect(result.payment.reference).toBe(generatedReference);
  });

  it("passes the store's currency to the provider", async () => {
    await setupHappy();

    await initiateCheckout(STORE_ID, checkoutBody(), providerFactory, "USD");

    const input = provider.initiateCheckout.mock.calls[0]![0] as CheckoutInitiationInput;
    expect(input.currency).toBe("USD");
  });

  it("reuses an existing customer by store + lowercase email", async () => {
    await setupHappy();
    prisma.customer.findFirst.mockResolvedValue({ id: "customer-9" });

    await initiateCheckout(
      STORE_ID,
      checkoutBody({ customer: { name: "Ade", email: "BUYER@example.com" } }),
      providerFactory,
    );

    expect(prisma.customer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { storeId: STORE_ID, email: "buyer@example.com" } }),
    );
    expect(prisma.customer.create).not.toHaveBeenCalled();
  });

  it("aggregates duplicate product entries into one line item", async () => {
    await setupHappy();
    prisma.product.findMany.mockResolvedValue([productRow({ quantity: 10 })]);

    await initiateCheckout(
      STORE_ID,
      checkoutBody({
        items: [
          { productId: "product-1", quantity: 2 },
          { productId: "product-1", quantity: 3 },
        ],
      }),
      providerFactory,
    );

    expect(tx.orderLineItem.createMany).toHaveBeenCalledWith({
      data: [
        {
          storeId: STORE_ID,
          orderId: "order-1",
          productId: "product-1",
          variantId: null,
          quantity: 5,
          unitPriceAtPurchase: expect.any(Prisma.Decimal),
        },
      ],
    });
    const orderCreateData = tx.order.create.mock.calls[0]![0].data as { total: Prisma.Decimal };
    expect(orderCreateData.total.toString()).toBe("49.95");
  });

  it("applies a discount code to the total and persists discountId/discountAmount", async () => {
    await setupHappy();
    prisma.discount.findFirst.mockResolvedValue({
      id: "discount-1",
      name: "Ten percent",
      type: "PERCENTAGE",
      value: new Prisma.Decimal("10"),
      isActive: true,
      startsAt: null,
      endsAt: null,
    });

    const result = await initiateCheckout(
      STORE_ID,
      checkoutBody({ discountCode: "ten" }),
      providerFactory,
    );

    expect(prisma.discount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { storeId: STORE_ID, code: "TEN" } }),
    );
    const orderCreateData = tx.order.create.mock.calls[0]![0].data as {
      total: Prisma.Decimal;
      discountAmount: Prisma.Decimal;
      discountId: string;
    };
    expect(orderCreateData.total.toString()).toBe("17.98");
    expect(orderCreateData.discountAmount.toString()).toBe("2");
    expect(orderCreateData.discountId).toBe("discount-1");
    const input = provider.initiateCheckout.mock.calls[0]![0] as CheckoutInitiationInput;
    expect(input.amount).toBe("17.98");
    expect(result.order.discountAmount).toBe("2.00");
  });

  it("creates a new checkout customer in the default General group", async () => {
    await setupHappy();

    await initiateCheckout(STORE_ID, checkoutBody(), providerFactory);

    expect(prisma.customerGroup.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { storeId: STORE_ID, name: "General" } }),
    );
    expect(prisma.customer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ groupId: "group-general" }),
      }),
    );
  });

  it("rejects an unknown discount code with 404 DISCOUNT_NOT_FOUND", async () => {
    await setupHappy();
    prisma.discount.findFirst.mockResolvedValue(null);

    await expect(
      initiateCheckout(STORE_ID, checkoutBody({ discountCode: "NOPE" }), providerFactory),
    ).rejects.toMatchObject({ code: "DISCOUNT_NOT_FOUND", statusCode: 404 });
    expect(tx.order.create).not.toHaveBeenCalled();
    expect(provider.initiateCheckout).not.toHaveBeenCalled();
  });
});

describe("initiateCheckout (unit) — sad paths", () => {
  it("rejects PAYMENT_NOT_CONFIGURED before creating any order when no keys exist", async () => {
    prisma.product.findMany.mockResolvedValue([productRow()]);
    prisma.branchStock.findMany.mockResolvedValue([
      branchStockRow("product-1", null, (productRow() as { quantity: number }).quantity),
    ]);
    prisma.paymentCredential.findUnique.mockResolvedValue(null);

    await expect(initiateCheckout(STORE_ID, checkoutBody(), providerFactory)).rejects.toMatchObject(
      {
        statusCode: 409,
        code: "PAYMENT_NOT_CONFIGURED",
      },
    );
    expect(tx.order.create).not.toHaveBeenCalled();
    expect(provider.initiateCheckout).not.toHaveBeenCalled();
  });

  it("rejects INSUFFICIENT_STOCK before payment is attempted", async () => {
    prisma.product.findMany.mockResolvedValue([productRow({ quantity: 1 })]);
    prisma.branchStock.findMany.mockResolvedValue([branchStockRow("product-1", null, 1)]);

    await expect(initiateCheckout(STORE_ID, checkoutBody(), providerFactory)).rejects.toMatchObject(
      {
        statusCode: 409,
        code: "INSUFFICIENT_STOCK",
      },
    );
    expect(provider.initiateCheckout).not.toHaveBeenCalled();
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it("rejects PRODUCT_UNAVAILABLE when a cart product was deleted", async () => {
    prisma.product.findMany.mockResolvedValue([
      productRow({ deletedAt: new Date("2026-08-01T00:00:00Z") }),
    ]);

    await expect(initiateCheckout(STORE_ID, checkoutBody(), providerFactory)).rejects.toMatchObject(
      {
        statusCode: 409,
        code: "PRODUCT_UNAVAILABLE",
      },
    );
    expect(provider.initiateCheckout).not.toHaveBeenCalled();
  });

  it("rejects PRODUCT_UNAVAILABLE when a cart product is not in this store", async () => {
    prisma.product.findMany.mockResolvedValue([]);

    await expect(initiateCheckout(STORE_ID, checkoutBody(), providerFactory)).rejects.toMatchObject(
      {
        statusCode: 409,
        code: "PRODUCT_UNAVAILABLE",
      },
    );
    expect(provider.initiateCheckout).not.toHaveBeenCalled();
  });

  it("marks the order CANCELLED and throws 502 when the provider fails", async () => {
    await setupHappy();
    provider.initiateCheckout.mockRejectedValue(
      new PaymentProviderError(401, "invalid key", "INVALID_API_KEY"),
    );

    await expect(initiateCheckout(STORE_ID, checkoutBody(), providerFactory)).rejects.toMatchObject(
      {
        statusCode: 502,
        code: "PAYMENT_PROVIDER_ERROR",
      },
    );
    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "CANCELLED" }) }),
    );
  });

  it("marks CANCELLED and rethrows unexpected errors instead of swallowing them", async () => {
    await setupHappy();
    provider.initiateCheckout.mockRejectedValue(new Error("boom"));

    await expect(initiateCheckout(STORE_ID, checkoutBody(), providerFactory)).rejects.toThrow(
      "boom",
    );
    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "CANCELLED" }) }),
    );
  });
});

describe("initiateCheckout (unit) — edge cases", () => {
  it("rejects an empty cart", async () => {
    await expect(
      initiateCheckout(STORE_ID, checkoutBody({ items: [] }), providerFactory),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "VALIDATION_ERROR",
    });
    expect(provider.initiateCheckout).not.toHaveBeenCalled();
  });

  it("rejects zero, negative, and oversized quantities", async () => {
    await expect(
      initiateCheckout(
        STORE_ID,
        checkoutBody({ items: [{ productId: "p", quantity: 0 }] }),
        providerFactory,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      initiateCheckout(
        STORE_ID,
        checkoutBody({ items: [{ productId: "p", quantity: -1 }] }),
        providerFactory,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      initiateCheckout(
        STORE_ID,
        checkoutBody({ items: [{ productId: "p", quantity: 10000 }] }),
        providerFactory,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a cart without customer contact info", async () => {
    await expect(
      initiateCheckout(STORE_ID, checkoutBody({ customer: { name: "Ade" } }), providerFactory),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("does not decrement stock or change the order status at initiation", async () => {
    await setupHappy();
    const result = (await initiateCheckout(
      STORE_ID,
      checkoutBody(),
      providerFactory,
    )) as CheckoutResult;

    expect(result.order.status).toBe("PENDING");
    const stockUpdateCalls = prisma.product.findMany.mock.calls.length;
    expect(stockUpdateCalls).toBe(1); // read-only lookup — never an UPDATE
    expect(prisma.order.update).toHaveBeenCalledTimes(1); // only the authorizationUrl write
  });

  it("keeps stock untouched on provider failure (no ledger entry)", async () => {
    await setupHappy();
    provider.initiateCheckout.mockRejectedValue(new PaymentProviderError(401, "invalid key"));

    await expect(initiateCheckout(STORE_ID, checkoutBody(), providerFactory)).rejects.toMatchObject(
      {
        statusCode: 502,
      },
    );
    expect(prisma.product.findMany).toHaveBeenCalledTimes(1);
  });

  it("uses the decryptable stored secret for the provider", async () => {
    await setupHappy();
    await initiateCheckout(STORE_ID, checkoutBody(), providerFactory);

    expect(decryptSecret(credentialRow().secretKeyEncrypted)).toBe(SECRET_KEY);
  });
});

describe("initiateCheckout (unit) — orderCap", () => {
  function attachSubscription(overrides: Record<string, unknown> = {}) {
    prisma.store.findUnique.mockResolvedValue({
      id: STORE_ID,
      subscriptionId: "sub-1",
      defaultBranchId: BRANCH_ID,
    });
    prisma.subscription.findUnique.mockResolvedValue(
      subscriptionRow({ orderCap: 2, ...overrides }),
    );
  }

  it("allows checkout under the cap (count < cap)", async () => {
    attachSubscription();
    prisma.order.count.mockResolvedValue(1); // 1 order in the billing period, cap 2
    await setupHappy();

    const result = await initiateCheckout(STORE_ID, checkoutBody(), providerFactory);

    expect(prisma.order.count).toHaveBeenCalledWith({
      where: {
        storeId: STORE_ID,
        createdAt: { gte: new Date("2026-08-02T00:00:00Z"), lt: new Date("2026-09-01T00:00:00Z") },
      },
    });
    expect(result.order.status).toBe("PENDING");
    expect(tx.order.create).toHaveBeenCalled();
  });

  it("rejects exactly at the cap (count == cap) with ORDER_LIMIT_REACHED", async () => {
    attachSubscription();
    prisma.order.count.mockResolvedValue(2); // at cap 2
    await setupHappy();

    await expect(initiateCheckout(STORE_ID, checkoutBody(), providerFactory)).rejects.toMatchObject(
      {
        statusCode: 409,
        code: "ORDER_LIMIT_REACHED",
      },
    );
    expect(tx.order.create).not.toHaveBeenCalled();
    expect(provider.initiateCheckout).not.toHaveBeenCalled();
  });

  it("rejects over the cap with an upgrade-promoting message", async () => {
    attachSubscription();
    prisma.order.count.mockResolvedValue(3); // over cap 2
    await setupHappy();

    const error = await initiateCheckout(STORE_ID, checkoutBody(), providerFactory).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toMatchObject({ statusCode: 409, code: "ORDER_LIMIT_REACHED" });
    expect((error as { message: string }).message).toMatch(/upgrade/i);
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it("is unlimited when the store has no subscription", async () => {
    prisma.order.count.mockResolvedValue(99999);
    await setupHappy();

    await initiateCheckout(STORE_ID, checkoutBody(), providerFactory);
    expect(prisma.order.count).not.toHaveBeenCalled();
    expect(tx.order.create).toHaveBeenCalled();
  });

  it("counts only the billing-period window, not all-time orders", async () => {
    attachSubscription();
    prisma.order.count.mockResolvedValue(0);
    await setupHappy();

    await initiateCheckout(STORE_ID, checkoutBody(), providerFactory);

    expect(prisma.order.count).toHaveBeenCalledWith({
      where: {
        storeId: STORE_ID,
        createdAt: { gte: new Date("2026-08-02T00:00:00Z"), lt: new Date("2026-09-01T00:00:00Z") },
      },
    });
  });
});

describe("initiateCheckout (unit) — variants", () => {
  async function setupVariantHappy(variant: Record<string, unknown> = {}) {
    prisma.product.findMany.mockResolvedValue([productRow({ variants: [{ id: "variant-1", archivedAt: null }] })]);
    prisma.productVariant.findMany.mockResolvedValue([variantRow(variant)]);
    prisma.branchStock.findMany.mockResolvedValue([
      branchStockRow("product-1", "variant-1", (variant.quantity as number | undefined) ?? 5),
    ]);
    prisma.paymentCredential.findUnique.mockResolvedValue(credentialRow());
    prisma.customer.findFirst.mockResolvedValue({ id: "customer-1" });
    prisma.order.update.mockResolvedValue({});
  }

  it("uses the variant's sellingPrice and writes the variantId on the line item", async () => {
    await setupVariantHappy();

    await initiateCheckout(
      STORE_ID,
      checkoutBody({ items: [{ productId: "product-1", variantId: "variant-1", quantity: 2 }] }),
      providerFactory,
    );

    expect(prisma.productVariant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { productId: { in: ["product-1"] }, storeId: STORE_ID, archivedAt: null },
      }),
    );
    expect(tx.orderLineItem.createMany).toHaveBeenCalledWith({
      data: [
        {
          storeId: STORE_ID,
          orderId: "order-1",
          productId: "product-1",
          variantId: "variant-1",
          quantity: 2,
          unitPriceAtPurchase: expect.any(Prisma.Decimal),
        },
      ],
    });
    const lineItem = tx.orderLineItem.createMany.mock.calls[0]![0].data[0] as {
      unitPriceAtPurchase: Prisma.Decimal;
    };
    expect(lineItem.unitPriceAtPurchase.toString()).toBe("11.99");
    const orderCreateData = tx.order.create.mock.calls[0]![0].data as { total: Prisma.Decimal };
    expect(orderCreateData.total.toString()).toBe("23.98");
  });

  it("falls back to the product price when the variant has no sellingPrice", async () => {
    await setupVariantHappy({ sellingPrice: null });

    await initiateCheckout(
      STORE_ID,
      checkoutBody({ items: [{ productId: "product-1", variantId: "variant-1", quantity: 1 }] }),
      providerFactory,
    );

    const lineItem = tx.orderLineItem.createMany.mock.calls[0]![0].data[0] as {
      unitPriceAtPurchase: Prisma.Decimal;
    };
    expect(lineItem.unitPriceAtPurchase.toString()).toBe("9.99");
  });

  it("rejects 400 VARIANT_NOT_FOUND when a variant line targets a variant-less product", async () => {
    prisma.product.findMany.mockResolvedValue([productRow()]);
    prisma.productVariant.findMany.mockResolvedValue([variantRow()]);

    await expect(
      initiateCheckout(
        STORE_ID,
        checkoutBody({ items: [{ productId: "product-1", variantId: "variant-1", quantity: 1 }] }),
        providerFactory,
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: "VARIANT_NOT_FOUND" });
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it("rejects 400 VARIANT_REQUIRED when a variant product is carted without a variant", async () => {
    await setupVariantHappy();

    await expect(initiateCheckout(STORE_ID, checkoutBody(), providerFactory)).rejects.toMatchObject(
      {
        statusCode: 400,
        code: "VARIANT_REQUIRED",
      },
    );
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it("rejects 409 PRODUCT_UNAVAILABLE when the variant does not belong to the product", async () => {
    prisma.product.findMany.mockResolvedValue([productRow({ variants: [{ id: "variant-1", archivedAt: null }] })]);
    prisma.productVariant.findMany.mockResolvedValue([variantRow({ productId: "product-other" })]);

    await expect(
      initiateCheckout(
        STORE_ID,
        checkoutBody({ items: [{ productId: "product-1", variantId: "variant-1", quantity: 1 }] }),
        providerFactory,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "PRODUCT_UNAVAILABLE" });
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it("rejects 409 PRODUCT_UNAVAILABLE when the variant id does not exist", async () => {
    prisma.product.findMany.mockResolvedValue([productRow({ variants: [{ id: "variant-1", archivedAt: null }] })]);
    prisma.productVariant.findMany.mockResolvedValue([]);

    await expect(
      initiateCheckout(
        STORE_ID,
        checkoutBody({
          items: [{ productId: "product-1", variantId: "variant-ghost", quantity: 1 }],
        }),
        providerFactory,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "PRODUCT_UNAVAILABLE" });
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it("rejects 409 INSUFFICIENT_STOCK naming the variant when its stock runs out", async () => {
    await setupVariantHappy({ quantity: 1 });

    await expect(
      initiateCheckout(
        STORE_ID,
        checkoutBody({ items: [{ productId: "product-1", variantId: "variant-1", quantity: 2 }] }),
        providerFactory,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "INSUFFICIENT_STOCK" });
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it("aggregates duplicate entries of the same variant and keeps sibling variants separate", async () => {
    prisma.product.findMany.mockResolvedValue([
      productRow({
        variants: [{ id: "variant-1", archivedAt: null }, { id: "variant-2", archivedAt: null }],
      }),
    ]);
    prisma.productVariant.findMany.mockResolvedValue([
      variantRow(),
      variantRow({
        id: "variant-2",
        name: "1L",
        sellingPrice: new Prisma.Decimal("15.99"),
        quantity: 9,
      }),
    ]);
    prisma.paymentCredential.findUnique.mockResolvedValue(credentialRow());
    prisma.customer.findFirst.mockResolvedValue({ id: "customer-1" });
    prisma.order.update.mockResolvedValue({});
    prisma.branchStock.findMany.mockResolvedValue([
      branchStockRow("product-1", "variant-1", 5),
      branchStockRow("product-1", "variant-2", 9),
    ]);

    await initiateCheckout(
      STORE_ID,
      checkoutBody({
        items: [
          { productId: "product-1", variantId: "variant-1", quantity: 2 },
          { productId: "product-1", variantId: "variant-2", quantity: 1 },
          { productId: "product-1", variantId: "variant-1", quantity: 3 },
        ],
      }),
      providerFactory,
    );

    const items = tx.orderLineItem.createMany.mock.calls[0]![0].data as {
      variantId: string | null;
      quantity: number;
      unitPriceAtPurchase: Prisma.Decimal;
    }[];
    expect(items.map((item) => [item.variantId, item.quantity])).toEqual([
      ["variant-1", 5],
      ["variant-2", 1],
    ]);
    const orderCreateData = tx.order.create.mock.calls[0]![0].data as { total: Prisma.Decimal };
    expect(orderCreateData.total.toString()).toBe("75.94");
  });
});
