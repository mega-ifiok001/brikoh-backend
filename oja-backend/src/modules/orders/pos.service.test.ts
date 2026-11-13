import { beforeEach, describe, expect, it, vi } from "vitest";

// Prisma + cross-module collaborators are stubbed at module boundaries.
const prismaMocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
const ledgerMocks = vi.hoisted(() => ({ recordSaleStockChanges: vi.fn() }));
const subscriptionsMocks = vi.hoisted(() => ({ enforceOrderCap: vi.fn() }));
const activityMocks = vi.hoisted(() => ({ logStoreActivity: vi.fn() }));

vi.mock("../../lib/prisma.js", () => ({
  getPrismaClient: prismaMocks.getPrismaClient,
}));
vi.mock("../products/ledger.service.js", () => ({
  recordSaleStockChanges: ledgerMocks.recordSaleStockChanges,
}));
vi.mock("../subscriptions/service.js", () => ({
  enforceOrderCap: subscriptionsMocks.enforceOrderCap,
}));
vi.mock("../activity/service.js", () => ({
  logStoreActivity: activityMocks.logStoreActivity,
}));

import { Prisma } from "../../../generated/prisma/client.js";
import type { PaymentProvider } from "../../lib/paymentProvider.js";
import { PaymentProviderError } from "../../lib/paymentProvider.js";
import { encryptSecret } from "../../lib/secrets.js";
import { recordPosSale, WALK_IN_CUSTOMER_NAME } from "./pos.service.js";
import { listOrders } from "./service.js";

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
  branch: { findFirst: Mock };
  product: { findMany: Mock };
  productVariant: { findMany: Mock };
  branchStock: { findMany: Mock };
  paymentCredential: { findUnique: Mock };
  customer: { findFirst: Mock; create: Mock };
  customerGroup: { findFirst: Mock; create: Mock };
  discount: { findFirst: Mock; findUnique: Mock };
  order: { findMany: Mock; update: Mock };
}

const STORE_ID = "store-1";
const BRANCH_ID = "branch-1";
const SECRET_KEY = "sk_test_1234abcd5678efgh";

function createPrismaStub(): PrismaStub {
  return {
    $transaction: vi.fn(async (fn: (tx: TxStub) => Promise<unknown>) => fn(createTxStub())),
    store: {
      findUnique: vi.fn().mockResolvedValue({ id: STORE_ID, defaultBranchId: BRANCH_ID }),
    },
    branch: {
      findFirst: vi.fn().mockResolvedValue({ id: BRANCH_ID, name: "Main Branch" }),
    },
    product: { findMany: vi.fn() },
    productVariant: { findMany: vi.fn().mockResolvedValue([]) },
    branchStock: { findMany: vi.fn().mockResolvedValue([]) },
    paymentCredential: { findUnique: vi.fn() },
    customer: { findFirst: vi.fn(), create: vi.fn() },
    customerGroup: {
      findFirst: vi.fn().mockResolvedValue({ id: "group-general" }),
      create: vi.fn(),
    },
    discount: { findFirst: vi.fn(), findUnique: vi.fn() },
    order: { findMany: vi.fn(), update: vi.fn() },
  };
}

function createTxStub(): TxStub {
  const couponRow = {
    id: "discount-1",
    storeId: STORE_ID,
    maxUses: null,
    perCustomerUses: null,
    minSubtotal: null,
    firstOrderOnly: null,
  };
  return {
    store: { update: vi.fn().mockResolvedValue({ orderCounter: 1 }) },
    discount: {
      findUnique: vi.fn().mockResolvedValue(couponRow),
    },
    couponRedemption: { count: vi.fn().mockResolvedValue(0), create: vi.fn() },
    order: {
      create: vi.fn().mockResolvedValue({
        id: "order-1",
        status: "PAID",
        createdAt: new Date("2026-08-12T10:00:00.000Z"),
      }),
    },
    orderLineItem: { createMany: vi.fn() },
  };
}

function productRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "product-1",
    storeId: STORE_ID,
    name: "Bottle",
    price: new Prisma.Decimal("9.99"),
    discountPrice: null,
    quantity: 10,
    deletedAt: null,
    variants: [],
    ...overrides,
  };
}

function variantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "variant-1",
    productId: "product-1",
    name: "500ml",
    sellingPrice: new Prisma.Decimal("11.99"),
    ...overrides,
  };
}

function branchStockRow(productId: string, variantId: string | null, quantity: number) {
  return { productId, variantId, quantity };
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

function posBody(overrides: Record<string, unknown> = {}) {
  return {
    items: [{ productId: "product-1", quantity: 2 }],
    paymentMethod: "CASH",
    ...overrides,
  };
}

let prisma: PrismaStub;
let tx: TxStub;
let provider: PaymentProvider & { initiateCheckout: Mock };

beforeEach(() => {
  vi.clearAllMocks();
  prisma = createPrismaStub();
  tx = createTxStub();
  prismaMocks.getPrismaClient.mockReturnValue(prisma);
  prisma.$transaction.mockImplementation(async (fn: (t: TxStub) => Promise<unknown>) => fn(tx));
  subscriptionsMocks.enforceOrderCap.mockResolvedValue(undefined);
  ledgerMocks.recordSaleStockChanges.mockResolvedValue([]);
  activityMocks.logStoreActivity.mockResolvedValue(undefined);
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

const providerFactory = (): PaymentProvider => provider;

function withStock(quantity = 10) {
  prisma.product.findMany.mockResolvedValue([productRow()]);
  prisma.productVariant.findMany.mockResolvedValue([]);
  prisma.branchStock.findMany.mockResolvedValue([branchStockRow("product-1", null, quantity)]);
}

async function setupInstantSale(
  overrides: Record<string, unknown> = {},
  stock = 10,
  staffMemberId?: string,
) {
  withStock(stock);
  prisma.customer.findFirst.mockResolvedValue(null);
  prisma.customer.create.mockResolvedValue({ id: "customer-1" });
  return recordPosSale(STORE_ID, staffMemberId, posBody(overrides), providerFactory);
}

describe("recordPosSale (unit) — CASH / TRANSFER / CREDIT", () => {
  it("records a PAID cash sale atomically: prices captured, stock decremented, staff attributed", async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: "customer-1" });
    const result = await setupInstantSale({}, 10, "staff-1");

    expect(result.order).toMatchObject({
      status: "PAID",
      total: "19.98",
      discountAmount: "0.00",
      amountPaid: "19.98",
      balanceDue: "0.00",
      paymentMethod: "CASH",
      source: "POS",
    });
    expect(result.payment).toBeNull();

    expect(ledgerMocks.recordSaleStockChanges).toHaveBeenCalledWith(tx, [
      {
        storeId: STORE_ID,
        branchId: BRANCH_ID,
        productId: "product-1",
        variantId: undefined,
        quantityChange: -2,
        performedByStaffId: "staff-1",
      },
    ]);
    expect(tx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          storeId: STORE_ID,
          branchId: BRANCH_ID,
          customerId: "customer-1",
          status: "PAID",
          paidAt: expect.any(Date),
          paymentMethod: "CASH",
          amountPaid: new Prisma.Decimal("19.98"),
          source: "POS",
          soldByStaffId: "staff-1",
        }),
      }),
    );
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        staffMemberId: "staff-1",
        action: "sale.recorded",
        detail: expect.objectContaining({ orderId: "order-1", paymentMethod: "CASH" }),
      }),
    );
  });

  it("prices with the product's discountPrice when set (per-product discount applies at POS)", async () => {
    prisma.product.findMany.mockResolvedValue([
      productRow({ price: new Prisma.Decimal("9.99"), discountPrice: new Prisma.Decimal("7.50") }),
    ]);
    prisma.branchStock.findMany.mockResolvedValue([branchStockRow("product-1", null, 10)]);
    prisma.customer.findFirst.mockResolvedValue({ id: "customer-1" });

    const result = await recordPosSale(STORE_ID, undefined, posBody(), providerFactory);

    expect(result.order.total).toBe("15.00");
  });

  it("prices variant lines with the variant sellingPrice (falls back to discountPrice, then price)", async () => {
    prisma.product.findMany.mockResolvedValue([
      productRow({
        variants: [{ id: "variant-1" }],
        discountPrice: new Prisma.Decimal("6.00"),
      }),
    ]);
    prisma.productVariant.findMany.mockResolvedValue([
      variantRow({ sellingPrice: new Prisma.Decimal("11.99") }),
    ]);
    prisma.branchStock.findMany.mockResolvedValue([branchStockRow("product-1", "variant-1", 10)]);
    prisma.customer.findFirst.mockResolvedValue({ id: "customer-1" });

    const result = await recordPosSale(
      STORE_ID,
      undefined,
      posBody({ items: [{ productId: "product-1", variantId: "variant-1", quantity: 1 }] }),
      providerFactory,
    );

    expect(result.order.total).toBe("11.99");
  });

  it("applies an explicit FIXED discount (by code) to the total", async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: "customer-1" });
    prisma.discount.findFirst.mockResolvedValue({
      id: "discount-1",
      name: "Ten off",
      type: "FIXED",
      value: new Prisma.Decimal("2.98"),
      isActive: true,
      startsAt: null,
      endsAt: null,
    });

    const result = await setupInstantSale({ discountCode: "TEN-OFF" });

    expect(prisma.discount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { storeId: STORE_ID, code: "TEN-OFF" } }),
    );
    expect(result.order.total).toBe("17.00");
    expect(result.order.discountAmount).toBe("2.98");
    expect(result.order.discountId).toBe("discount-1");
    expect(result.order.amountPaid).toBe("17.00");
    expect(tx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ discountId: "discount-1" }),
      }),
    );
  });

  it("caps an explicit FIXED discount at the line total", async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: "customer-1" });
    prisma.discount.findFirst.mockResolvedValue({
      id: "discount-1",
      name: "Big off",
      type: "FIXED",
      value: new Prisma.Decimal("25.00"),
      isActive: true,
      startsAt: null,
      endsAt: null,
    });

    const result = await setupInstantSale({ discountCode: "BIG-OFF" });

    expect(result.order.total).toBe("0.00");
    expect(result.order.discountAmount).toBe("19.98");
  });

  it("rejects an unknown discount code (404 DISCOUNT_NOT_FOUND)", async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: "customer-1" });
    prisma.discount.findFirst.mockResolvedValue(null);

    await expect(setupInstantSale({ discountCode: "NOPE" })).rejects.toMatchObject({
      code: "DISCOUNT_NOT_FOUND",
      statusCode: 404,
    });
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it("rejects a discount that is inactive or outside its window (400 DISCOUNT_UNAVAILABLE)", async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: "customer-1" });
    prisma.discount.findFirst.mockResolvedValue({
      id: "discount-1",
      name: "Lapsed",
      type: "PERCENTAGE",
      value: new Prisma.Decimal("10"),
      isActive: false,
      startsAt: null,
      endsAt: null,
    });

    await expect(setupInstantSale({ discountCode: "LAPSED" })).rejects.toMatchObject({
      code: "DISCOUNT_UNAVAILABLE",
      statusCode: 400,
    });
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it("auto-applies the customer's group discount when no explicit discount is given", async () => {
    withStock();
    prisma.customer.findFirst.mockImplementation(
      async ({ where }: { where: { id?: string; storeId?: string } }) => {
        if (where.id === "customer-1" && where.storeId !== undefined) {
          return {
            id: "customer-1",
            email: null,
            group: { discount: { id: "discount-1" } },
          };
        }
        return { id: "customer-1", email: null };
      },
    );
    prisma.discount.findUnique.mockResolvedValue({
      id: "discount-1",
      name: "Members 10%",
      type: "PERCENTAGE",
      value: new Prisma.Decimal("10"),
      isActive: true,
      startsAt: null,
      endsAt: null,
    });

    const result = await recordPosSale(STORE_ID, undefined, posBody(), providerFactory);

    expect(result.order.total).toBe("17.98");
    expect(result.order.discountAmount).toBe("2.00");
    expect(result.order.discountId).toBe("discount-1");
  });

  it("skips an unavailable group discount without failing the sale", async () => {
    withStock();
    prisma.customer.findFirst.mockImplementation(
      async ({ where }: { where: { id?: string; storeId?: string } }) => {
        if (where.id === "customer-1" && where.storeId !== undefined) {
          return {
            id: "customer-1",
            email: null,
            group: { discount: { id: "discount-1" } },
          };
        }
        return { id: "customer-1", email: null };
      },
    );
    prisma.discount.findUnique.mockResolvedValue({
      id: "discount-1",
      name: "Lapsed group",
      type: "PERCENTAGE",
      value: new Prisma.Decimal("10"),
      isActive: false,
      startsAt: null,
      endsAt: null,
    });

    const result = await recordPosSale(STORE_ID, undefined, posBody(), providerFactory);

    expect(result.order.total).toBe("19.98");
    expect(result.order.discountAmount).toBe("0.00");
    expect(result.order.discountId).toBeNull();
  });

  it("rejects an amountPaid that exceeds the total (400 VALIDATION_ERROR)", async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: "customer-1" });
    await expect(setupInstantSale({ amountPaid: "500.00" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      statusCode: 400,
    });
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it("records CREDIT sales with amountPaid defaulting to 0.00 and the full balance due", async () => {
    const result = await setupInstantSale({ paymentMethod: "CREDIT" });

    expect(result.order).toMatchObject({
      status: "PAID",
      amountPaid: "0.00",
      balanceDue: "19.98",
    });
  });

  it("records a partial credit payment and reports the remaining balance due", async () => {
    const result = await setupInstantSale({ paymentMethod: "CREDIT", amountPaid: "10.00" });

    expect(result.order.amountPaid).toBe("10.00");
    expect(result.order.balanceDue).toBe("9.98");
  });

  it("lets an owner record a sale without staff attribution", async () => {
    const result = await setupInstantSale({}, 10, undefined);

    expect(tx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ soldByStaffId: null }) }),
    );
    expect(ledgerMocks.recordSaleStockChanges).toHaveBeenCalledWith(
      tx,
      expect.arrayContaining([expect.objectContaining({ performedByStaffId: undefined })]),
    );
    expect(result.order.status).toBe("PAID");
  });

  it("rejects an oversold cart with INSUFFICIENT_STOCK before any write", async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: "customer-1" });

    await expect(setupInstantSale({}, 1)).rejects.toMatchObject({
      code: "INSUFFICIENT_STOCK",
      statusCode: 409,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(ledgerMocks.recordSaleStockChanges).not.toHaveBeenCalled();
  });

  it("rejects an unknown customerId (404 CUSTOMER_NOT_FOUND)", async () => {
    withStock();
    prisma.customer.findFirst.mockResolvedValue(null);

    await expect(
      recordPosSale(
        STORE_ID,
        "staff-1",
        posBody({ customerId: "00000000-0000-4000-8000-000000000000" }),
        providerFactory,
      ),
    ).rejects.toMatchObject({ code: "CUSTOMER_NOT_FOUND", statusCode: 404 });
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it("lazily uses the store's shared Walk-in Customer row for anonymous sales", async () => {
    withStock();
    prisma.customer.findFirst.mockResolvedValue({ id: "walk-in-1" });

    await recordPosSale(STORE_ID, "staff-1", posBody(), providerFactory);

    expect(prisma.customer.findFirst).toHaveBeenCalledWith({
      where: { storeId: STORE_ID, name: WALK_IN_CUSTOMER_NAME },
      select: { id: true, email: true },
    });
    expect(tx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ customerId: "walk-in-1" }) }),
    );
  });

  it("creates the Walk-in Customer row on first anonymous sale", async () => {
    withStock();
    prisma.customer.findFirst.mockResolvedValue(null);
    prisma.customer.create.mockResolvedValue({ id: "walk-in-1" });

    await recordPosSale(STORE_ID, "staff-1", posBody(), providerFactory);

    expect(prisma.customer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          storeId: STORE_ID,
          name: WALK_IN_CUSTOMER_NAME,
          source: "POS",
        }),
      }),
    );
  });

  it("accepts an explicit branch when the sale is from another branch", async () => {
    prisma.branch.findFirst.mockResolvedValue({
      id: "20000000-0000-4000-8000-000000000002",
      name: "Online Store",
    });
    prisma.product.findMany.mockResolvedValue([productRow()]);
    prisma.productVariant.findMany.mockResolvedValue([]);
    prisma.branchStock.findMany.mockResolvedValue([branchStockRow("product-1", null, 10)]);
    prisma.customer.findFirst.mockResolvedValue({ id: "customer-1" });

    const result = await recordPosSale(
      STORE_ID,
      "staff-1",
      posBody({ branchId: "20000000-0000-4000-8000-000000000002" }),
      providerFactory,
    );

    expect(result.order.status).toBe("PAID");
    expect(ledgerMocks.recordSaleStockChanges).toHaveBeenCalledWith(
      tx,
      expect.arrayContaining([
        expect.objectContaining({ branchId: "20000000-0000-4000-8000-000000000002" }),
      ]),
    );
  });

  it("rejects a branch that does not belong to the store (404 BRANCH_NOT_FOUND)", async () => {
    prisma.branch.findFirst.mockResolvedValue(null);

    await expect(
      recordPosSale(
        STORE_ID,
        "staff-1",
        posBody({ branchId: "30000000-0000-4000-8000-000000000000" }),
        providerFactory,
      ),
    ).rejects.toMatchObject({ code: "BRANCH_NOT_FOUND", statusCode: 404 });
  });

  it("rejects a store without a default branch when no branchId is given (409 STORE_NOT_CONFIGURED)", async () => {
    prisma.store.findUnique.mockResolvedValue({ id: STORE_ID, defaultBranchId: null });

    await expect(
      recordPosSale(STORE_ID, "staff-1", posBody(), providerFactory),
    ).rejects.toMatchObject({ code: "STORE_NOT_CONFIGURED", statusCode: 409 });
  });

  it("enforces the order cap like checkout", async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: "customer-1" });
    withStock();

    await setupInstantSale();

    expect(subscriptionsMocks.enforceOrderCap).toHaveBeenCalledWith(STORE_ID);
  });
});

describe("recordPosSale (unit) — CARD", () => {
  function setupCard() {
    withStock();
    prisma.paymentCredential.findUnique.mockResolvedValue(credentialRow());
    prisma.customer.findFirst.mockResolvedValue(null);
    prisma.customer.create.mockResolvedValue({ id: "customer-1" });
  }

  it("creates a PENDING order (no stock decrement) and initiates the hosted checkout", async () => {
    setupCard();

    const result = await recordPosSale(
      STORE_ID,
      "staff-1",
      posBody({
        paymentMethod: "CARD",
        email: "card-buyer@example.com",
      }),
      providerFactory,
    );

    expect(result.order).toMatchObject({
      status: "PENDING",
      total: "19.98",
      amountPaid: null,
      paymentMethod: "CARD",
      source: "POS",
    });
    expect(result.payment).toEqual({
      provider: "paystack",
      reference: expect.stringMatching(/^BRK-[A-Z0-9]{10}$/),
      redirectUrl: "https://checkout.paystack.test/session",
    });
    // CARD holds no stock: the ledger decrement must NOT run.
    expect(ledgerMocks.recordSaleStockChanges).not.toHaveBeenCalled();
    expect(tx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "PENDING",
          paymentMethod: "CARD",
          paymentProvider: "paystack",
          amountPaid: null,
        }),
      }),
    );
    expect(provider.initiateCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: "19.98",
        email: "card-buyer@example.com",
        reference: expect.stringMatching(/^BRK-/),
        metadata: { orderId: "order-1" },
      }),
    );
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: { authorizationUrl: "https://checkout.paystack.test/session" },
    });
  });

  it("prefers the customer's own email over the request override", async () => {
    setupCard();
    prisma.customer.findFirst.mockResolvedValue({ id: "customer-1" });
    prisma.customer.create.mockResolvedValue({ id: "customer-1" });
    prisma.customer.findFirst.mockResolvedValue({
      id: "customer-1",
      email: "known@example.com",
    });

    await recordPosSale(
      STORE_ID,
      "staff-1",
      posBody({ paymentMethod: "CARD", email: "override@example.com" }),
      providerFactory,
    );

    expect(provider.initiateCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ email: "known@example.com" }),
    );
  });

  it("rejects a CARD sale with no email anywhere (400 VALIDATION_ERROR)", async () => {
    setupCard();

    await expect(
      recordPosSale(STORE_ID, "staff-1", posBody({ paymentMethod: "CARD" }), providerFactory),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });
    expect(tx.order.create).not.toHaveBeenCalled();
    expect(provider.initiateCheckout).not.toHaveBeenCalled();
  });

  it("rejects a CARD sale without Paystack credentials (409 PAYMENT_NOT_CONFIGURED)", async () => {
    withStock();
    prisma.paymentCredential.findUnique.mockResolvedValue(null);
    prisma.customer.findFirst.mockResolvedValue({ id: "customer-1" });

    await expect(
      recordPosSale(
        STORE_ID,
        "staff-1",
        posBody({ paymentMethod: "CARD", email: "card@example.com" }),
        providerFactory,
      ),
    ).rejects.toMatchObject({ code: "PAYMENT_NOT_CONFIGURED", statusCode: 409 });
  });

  it("cancels the order and throws 502 when provider initiation fails", async () => {
    setupCard();
    provider.initiateCheckout.mockRejectedValue(
      new PaymentProviderError(500, "upstream is down", "UPSTREAM_ERR"),
    );

    await expect(
      recordPosSale(
        STORE_ID,
        "staff-1",
        posBody({ paymentMethod: "CARD", email: "card@example.com" }),
        providerFactory,
      ),
    ).rejects.toMatchObject({ code: "PAYMENT_PROVIDER_ERROR", statusCode: 502 });
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: { status: "CANCELLED" },
    });
  });
});

describe("listOrders (unit)", () => {
  function orderRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "order-1",
      status: "PAID",
      paymentMethod: "CASH",
      source: "POS",
      total: new Prisma.Decimal("19.98"),
      discountAmount: new Prisma.Decimal("0.00"),
      amountPaid: new Prisma.Decimal("19.98"),
      deliveryKind: null,
      deliveryOptionName: null,
      deliveryAddress: null,
      deliveryCity: null,
      deliveryState: null,
      deliveryPhone: null,
      deliveryInstructions: null,
      deliveryFee: new Prisma.Decimal("0.00"),
      createdAt: new Date("2026-08-12T10:00:00.000Z"),
      customer: { id: "customer-1", name: "Ade Okafor", phone: "+234", email: null },
      branch: { id: BRANCH_ID, name: "Main Branch" },
      soldByStaff: {
        id: "staff-1",
        account: { firstName: "Chidi", lastName: "Manager", email: "staff@example.com" },
      },
      _count: { lineItems: 2 },
      ...overrides,
    };
  }

  it("passes filters through to the query (status, method, source, range, q, cursor)", async () => {
    prisma.order.findMany.mockResolvedValue([orderRow()]);
    prismaMocks.getPrismaClient.mockReturnValue(prisma);

    await listOrders(STORE_ID, {
      status: "PAID",
      paymentMethod: "CASH",
      source: "POS",
      start: "2026-08-01T00:00:00.000Z",
      end: "2026-08-13T00:00:00.000Z",
      q: "ade",
      cursor: "order-9",
      limit: 20,
    });

    const [call] = prisma.order.findMany.mock.calls;
    expect(call![0]).toEqual(
      expect.objectContaining({
        where: {
          storeId: STORE_ID,
          status: "PAID",
          paymentMethod: "CASH",
          source: "POS",
          id: { lt: "order-9" },
          createdAt: {
            gte: new Date("2026-08-01T00:00:00.000Z"),
            lt: new Date("2026-08-13T00:00:00.000Z"),
          },
          customer: {
            OR: [
              { name: { contains: "ade", mode: "insensitive" } },
              { phone: { contains: "ade", mode: "insensitive" } },
            ],
          },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 20,
      }),
    );
  });

  it("computes balanceDue only for CREDIT orders (total - amountPaid)", async () => {
    prisma.order.findMany.mockResolvedValue([
      orderRow({
        id: "credit-1",
        paymentMethod: "CREDIT",
        total: new Prisma.Decimal("100.00"),
        amountPaid: new Prisma.Decimal("30.00"),
      }),
      orderRow({ id: "storefront-1", paymentMethod: null, amountPaid: null }),
    ]);

    const page = await listOrders(STORE_ID, { limit: 20 });

    expect(page.items[0]!.balanceDue).toBe("70.00");
    expect(page.items[1]!.balanceDue).toBe("0.00");
    expect(page.items[1]!.amountPaid).toBeNull();
  });

  it("names the selling staff from the account (first + last name)", async () => {
    prisma.order.findMany.mockResolvedValue([orderRow()]);

    const page = await listOrders(STORE_ID, { limit: 20 });

    expect(page.items[0]!.soldBy).toEqual({ id: "staff-1", name: "Chidi Manager" });
  });

  it("returns a nextCursor only when a full page was returned", async () => {
    prisma.order.findMany.mockResolvedValue([orderRow()]);

    const one = await listOrders(STORE_ID, { limit: 1 });
    expect(one.nextCursor).toBe("order-1");

    prisma.order.findMany.mockResolvedValue([]);
    const empty = await listOrders(STORE_ID, { limit: 1 });
    expect(empty.nextCursor).toBeNull();
  });
});
