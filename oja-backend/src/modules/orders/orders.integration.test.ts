import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../../../app.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { signAccessToken } from "../../lib/tokens.js";
import { decryptSecret, encryptSecret } from "../../lib/secrets.js";

const prisma = createPrismaClient(process.env.TEST_DATABASE_URL);

const SECRET_KEY = "sk_test_1234abcd5678efgh";

function paystackSuccessResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      status: true,
      message: "Authorization URL created",
      data: {
        authorization_url: "https://checkout.paystack.test/session",
        access_code: "access-1",
        reference: "any",
      },
    }),
  } as unknown as Response;
}

function paystackErrorResponse(status: number, message: string) {
  return {
    ok: false,
    status,
    json: async () => ({ status: false, message }),
  } as unknown as Response;
}

async function createAccount(password = "password-123") {
  const email = `account-${crypto.randomUUID()}@example.com`;
  const account = await prisma.account.create({
    data: { email, passwordHash: bcrypt.hashSync(password, 4) },
  });
  return { account, email };
}

async function createTenantWithOwner(currency: "NGN" | "USD" | "GHS" | "KES" | "ZAR" = "NGN") {
  const { account, email } = await createAccount();
  const store = await prisma.store.create({
    data: {
      name: `Store ${crypto.randomUUID().slice(0, 8)}`,
      subdomain: `s-${crypto.randomUUID().slice(0, 8)}`,
      businessType: "OTHER",
      location: "Lagos, Nigeria",
      businessPhone: "+234 801 234 5678",
      currency,
    },
  });
  // Checkout draws stock from the store's default branch — every test
  // tenant gets a Main Branch like onboarding does.
  const mainBranch = await prisma.branch.create({
    data: { storeId: store.id, name: "Main Branch", address: "Lagos, Nigeria" },
  });
  await prisma.store.update({ where: { id: store.id }, data: { defaultBranchId: mainBranch.id } });
  await prisma.owner.create({ data: { accountId: account.id, storeId: store.id } });
  const token = signAccessToken({ sub: account.id, storeId: store.id, role: "OWNER" });
  return { account, email, store, mainBranch, token };
}

async function createProduct(storeId: string, overrides: Record<string, unknown> = {}) {
  const { defaultBranchId } = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    select: { defaultBranchId: true },
  });
  const product = await prisma.product.create({
    data: {
      storeId,
      name: `Product ${crypto.randomUUID().slice(0, 8)}`,
      price: 9.99,
      quantity: 10,
      // Checkout only sees PUBLISHED products; helper rows are
      // buyable by default, DRAFT is set explicitly when testing the gate.
      status: "PUBLISHED",
      ...overrides,
    },
  });
  await prisma.branchStock.create({
    data: {
      storeId,
      branchId: defaultBranchId!,
      productId: product.id,
      variantId: null,
      quantity: (overrides.quantity as number | undefined) ?? 10,
    },
  });
  return product;
}

async function configurePaystack(storeId: string) {
  await prisma.paymentCredential.create({
    data: {
      storeId,
      provider: "paystack",
      publicKey: "pk_test_1234abcd",
      secretKeyEncrypted: encryptSecret(SECRET_KEY),
    },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  await prisma.$executeRaw`
    ALTER TABLE "StockLedgerEntry" DISABLE TRIGGER stock_ledger_append_only;
    ALTER TABLE "StoreActivityLog" DISABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "PurchaseOrderReceipt" DISABLE TRIGGER purchase_order_receipt_append_only;
    ALTER TABLE "PurchaseOrderPayment" DISABLE TRIGGER purchase_order_payment_append_only;
    ALTER TABLE "WalletEntry" DISABLE TRIGGER wallet_ledger_append_only;
    DELETE FROM "RefreshToken"; DELETE FROM "WebhookEvent"; DELETE FROM "OrderLineItem";
    DELETE FROM "Order"; DELETE FROM "Discount"; DELETE FROM "CustomerGroup"; DELETE FROM "InvoiceLineItem"; DELETE FROM "Invoice";
    DELETE FROM "WalletEntry"; DELETE FROM "Payout"; DELETE FROM "StoreWallet"; DELETE FROM "BankAccount";
    DELETE FROM "PurchaseOrderReceiptLine"; DELETE FROM "PurchaseOrderReceipt"; DELETE FROM "PurchaseOrderPayment"; DELETE FROM "PurchaseOrderLineItem"; DELETE FROM "PurchaseOrder"; DELETE FROM "Supplier";
    DELETE FROM "StockLedgerEntry"; DELETE FROM "Category"; DELETE FROM "Unit"; DELETE FROM "Product"; DELETE FROM "Customer";
    DELETE FROM "PurchaseOrderReceiptLine"; DELETE FROM "PurchaseOrderReceipt"; DELETE FROM "PurchaseOrderPayment"; DELETE FROM "PurchaseOrderLineItem"; DELETE FROM "PurchaseOrder"; DELETE FROM "Supplier";
    DELETE FROM "BranchStock"; DELETE FROM "Branch";
    DELETE FROM "StaffMember"; DELETE FROM "InviteToken"; DELETE FROM "Owner";
    DELETE FROM "StoreActivityLog";
    DELETE FROM "PaymentCredential"; DELETE FROM "Subscription"; DELETE FROM "Store";
    DELETE FROM "Account";
    ALTER TABLE "StoreActivityLog" ENABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "PurchaseOrderReceipt" ENABLE TRIGGER purchase_order_receipt_append_only;
    ALTER TABLE "PurchaseOrderPayment" ENABLE TRIGGER purchase_order_payment_append_only;
    ALTER TABLE "WalletEntry" ENABLE TRIGGER wallet_ledger_append_only;
    ALTER TABLE "StockLedgerEntry" ENABLE TRIGGER stock_ledger_append_only;
  `;
  fetchMock = vi.fn(async () => paystackSuccessResponse());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function checkoutBody(overrides: Record<string, unknown> = {}) {
  return {
    customer: { name: "Ade Buyer", email: "buyer@example.com", phone: "08012345678" },
    items: [{ productId: "product-1", quantity: 2 }],
    ...overrides,
  };
}

describe("POST /api/public/checkout/:subdomain (integration)", () => {
  it("creates a PENDING order + line items with captured prices; stock untouched; returns redirect", async () => {
    const { store } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const product = await createProduct(store.id);
    const quantityBefore = (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
      .quantity;

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(checkoutBody({ items: [{ productId: product.id, quantity: 2 }] }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      order: { total: "19.98", status: "PENDING" },
      payment: {
        provider: "paystack",
        redirectUrl: "https://checkout.paystack.test/session",
      },
    });
    expect(res.body.order.id).toEqual(expect.any(String));
    expect(res.body.payment.reference).toMatch(/^BRK-/);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.order.id } });
    expect(order.status).toBe("PENDING");
    expect(order.paymentProvider).toBe("paystack");
    expect(order.paymentReference).toBe(res.body.payment.reference);
    expect(order.authorizationUrl).toBe("https://checkout.paystack.test/session");

    const lineItems = await prisma.orderLineItem.findMany({ where: { orderId: order.id } });
    expect(lineItems).toHaveLength(1);
    expect(lineItems[0]).toMatchObject({
      productId: product.id,
      quantity: 2,
    });
    expect(lineItems[0]!.unitPriceAtPurchase.toString()).toBe("9.99");

    // Deliverable: initiation must NOT touch stock.
    const quantityAfter = (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
      .quantity;
    expect(quantityAfter).toBe(quantityBefore);
    expect(await prisma.stockLedgerEntry.count({ where: { storeId: store.id } })).toBe(0);
  });

  it("sends the decrypted secret and kobo amount to the provider", async () => {
    const { store } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const product = await createProduct(store.id);

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(checkoutBody({ items: [{ productId: product.id, quantity: 3 }] }));

    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.paystack.co/transaction/initialize");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET_KEY}`);
    const body = JSON.parse(String(init.body)) as { amount: string; reference: string };
    expect(body.amount).toBe("2997"); // 29.97 naira in kobo
    expect(body.reference).toBe(res.body.payment.reference);
  });

  it("charges the store's profile currency (never client-supplied)", async () => {
    const { store } = await createTenantWithOwner("USD");
    await configurePaystack(store.id);
    const product = await createProduct(store.id);

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(checkoutBody({ items: [{ productId: product.id, quantity: 2 }] }));

    expect(res.status).toBe(200);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { currency: string; amount: string };
    expect(body.currency).toBe("USD");
    // The minor-unit math is currency-agnostic for 2-decimal currencies:
    // 19.98 USD charges 1998 cents.
    expect(body.amount).toBe("1998");
  });

  it("rejects with INSUFFICIENT_STOCK before any provider call", async () => {
    const { store } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const product = await createProduct(store.id, { quantity: 1 });

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(checkoutBody({ items: [{ productId: product.id, quantity: 2 }] }));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INSUFFICIENT_STOCK");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await prisma.order.count({ where: { storeId: store.id } })).toBe(0);
  });

  it("rejects PRODUCT_UNAVAILABLE for a deleted product", async () => {
    const { store } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const product = await createProduct(store.id, { deletedAt: new Date() });

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(checkoutBody({ items: [{ productId: product.id, quantity: 1 }] }));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PRODUCT_UNAVAILABLE");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects PRODUCT_UNAVAILABLE for a DRAFT (unpublished) product", async () => {
    const { store } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const product = await createProduct(store.id, { status: "DRAFT" });

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(checkoutBody({ items: [{ productId: product.id, quantity: 1 }] }));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PRODUCT_UNAVAILABLE");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await prisma.order.count({ where: { storeId: store.id } })).toBe(0);
  });

  it("rejects PRODUCT_UNAVAILABLE for a product that belongs to another store (isolation)", async () => {
    const { store } = await createTenantWithOwner();
    const other = await createTenantWithOwner();
    await configurePaystack(store.id);
    const foreignProduct = await createProduct(other.store.id);

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(checkoutBody({ items: [{ productId: foreignProduct.id, quantity: 1 }] }));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PRODUCT_UNAVAILABLE");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 404 STORE_NOT_FOUND for an unknown subdomain", async () => {
    const res = await request(app)
      .post("/api/public/checkout/no-such-store")
      .send(checkoutBody({ items: [{ productId: "p", quantity: 1 }] }));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("STORE_NOT_FOUND");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects with PAYMENT_NOT_CONFIGURED when no keys exist and creates no order", async () => {
    const { store } = await createTenantWithOwner();
    const product = await createProduct(store.id);

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(checkoutBody({ items: [{ productId: product.id, quantity: 1 }] }));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PAYMENT_NOT_CONFIGURED");
    expect(await prisma.order.count({ where: { storeId: store.id } })).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks the order CANCELLED (no dangling PENDING) and returns 502 on provider failure", async () => {
    const { store } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const product = await createProduct(store.id);
    fetchMock.mockImplementation(async () => paystackErrorResponse(401, "Invalid key"));

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(checkoutBody({ items: [{ productId: product.id, quantity: 1 }] }));

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("PAYMENT_PROVIDER_ERROR");

    const orders = await prisma.order.findMany({ where: { storeId: store.id } });
    expect(orders).toHaveLength(1);
    expect(orders[0]!.status).toBe("CANCELLED");
    expect(orders[0]!.paymentReference).toMatch(/^BRK-/);
  });

  it("rejects a zero-item cart with 400", async () => {
    const { store } = await createTenantWithOwner();
    await configurePaystack(store.id);

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(checkoutBody({ items: [] }));

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid quantities with 400", async () => {
    const { store } = await createTenantWithOwner();
    await configurePaystack(store.id);

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(checkoutBody({ items: [{ productId: "p", quantity: 0 }] }));

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a cart without customer contact info with 400", async () => {
    const { store } = await createTenantWithOwner();
    await configurePaystack(store.id);

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(checkoutBody({ customer: { name: "No Email" } }));

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reuses one customer row across repeat checkouts with the same email", async () => {
    const { store } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const product = await createProduct(store.id);

    const first = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(checkoutBody({ items: [{ productId: product.id, quantity: 1 }] }));
    const second = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(checkoutBody({ items: [{ productId: product.id, quantity: 1 }] }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await prisma.customer.count({ where: { storeId: store.id } })).toBe(1);
    const orders = await prisma.order.findMany({ where: { storeId: store.id } });
    expect(orders).toHaveLength(2);
    expect(orders[0]!.customerId).toBe(orders[1]!.customerId);
  });

  it("aggregates duplicate cart entries into one line item", async () => {
    const { store } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const product = await createProduct(store.id);

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(
        checkoutBody({
          items: [
            { productId: product.id, quantity: 2 },
            { productId: product.id, quantity: 3 },
          ],
        }),
      );

    expect(res.status).toBe(200);
    expect(res.body.order.total).toBe("49.95");

    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.order.id } });
    const lines = await prisma.orderLineItem.findMany({ where: { orderId: order.id } });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.quantity).toBe(5);
  });

  it("enforces the store-scoped line-item trigger (at least one item, edge)", async () => {
    const { store } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const product = await createProduct(store.id);

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(checkoutBody({ items: [{ productId: product.id, quantity: 1 }] }));

    expect(res.status).toBe(200);
    expect(await prisma.orderLineItem.count({ where: { storeId: store.id } })).toBe(1);
    void decryptSecret;
  });

  it("applies a discount code to the total and persists discountId/discountAmount", async () => {
    const { store } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const product = await createProduct(store.id);
    const discount = await prisma.discount.create({
      data: { storeId: store.id, name: "Ten percent", type: "PERCENTAGE", value: 10, code: "TEN" },
    });

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(
        checkoutBody({
          items: [{ productId: product.id, quantity: 2 }],
          discountCode: "ten",
        }),
      );

    expect(res.status).toBe(200);
    expect(res.body.order).toMatchObject({
      total: "17.98",
      discountAmount: "2.00",
      discountId: discount.id,
    });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.order.id } });
    expect(order.discountId).toBe(discount.id);
    expect(order.discountAmount.toString()).toBe("2");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { amount: string };
    expect(body.amount).toBe("1798");
  });

  it("rejects an unknown discount code with 404 DISCOUNT_NOT_FOUND at checkout", async () => {
    const { store } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const product = await createProduct(store.id);

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(
        checkoutBody({
          items: [{ productId: product.id, quantity: 1 }],
          discountCode: "NOPE",
        }),
      );

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("DISCOUNT_NOT_FOUND");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lands new checkout customers in the default General group", async () => {
    const { store } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const product = await createProduct(store.id);

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(checkoutBody({ items: [{ productId: product.id, quantity: 1 }] }));

    expect(res.status).toBe(200);
    const general = await prisma.customerGroup.findFirst({
      where: { storeId: store.id, name: "General" },
    });
    expect(general).not.toBeNull();
    const customer = await prisma.customer.findFirst({
      where: { storeId: store.id, email: "buyer@example.com" },
    });
    expect(customer?.groupId).toBe(general?.id);
  });
});

describe("store-sequential order numbers (integration)", () => {
  it("assigns ORD-0001, then ORD-0002 in creation order across checkout + POS", async () => {
    const { store, token } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const product = await createProduct(store.id);

    const checkout = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(checkoutBody({ items: [{ productId: product.id, quantity: 1 }] }));

    expect(checkout.status).toBe(200);
    expect(checkout.body.order.orderNumber).toBe("ORD-0001");

    const first = await prisma.order.findUniqueOrThrow({
      where: { id: checkout.body.order.id },
    });
    expect(first.orderNumber).toBe("ORD-0001");

    const pos = await request(app)
      .post("/api/dashboard/orders")
      .set("Authorization", `Bearer ${token}`)
      .send({
        items: [{ productId: product.id, quantity: 1 }],
        paymentMethod: "CASH",
        customerId: (await prisma.customer.findFirstOrThrow({ where: { storeId: store.id } })).id,
      });

    expect(pos.status).toBe(201);
    expect(pos.body.order.orderNumber).toBe("ORD-0002");

    const second = await prisma.order.findUniqueOrThrow({ where: { id: pos.body.order.id } });
    expect(second.orderNumber).toBe("ORD-0002");
  });

  it("exposes orderNumber in the list and detail reads", async () => {
    const { store, token } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const product = await createProduct(store.id);

    const checkout = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(checkoutBody({ items: [{ productId: product.id, quantity: 1 }] }));

    const orderId = checkout.body.order.id;

    const list = await request(app)
      .get("/api/dashboard/orders")
      .set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.items[0]).toMatchObject({ id: orderId, orderNumber: "ORD-0001" });

    const detail = await request(app)
      .get(`/api/dashboard/orders/${orderId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.order.orderNumber).toBe("ORD-0001");
  });
});

describe("checkout origin attribution (integration)", () => {
  it("tags the order source from the origin param", async () => {
    const { store } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const product = await createProduct(store.id);

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(
        checkoutBody({
          items: [{ productId: product.id, quantity: 1 }],
          origin: "SOCIAL",
        }),
      );

    expect(res.status).toBe(200);
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: res.body.order.id },
    });
    expect(order.source).toBe("SOCIAL");
  });

  it("defaults to STOREFRONT when origin is omitted", async () => {
    const { store } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const product = await createProduct(store.id);

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(checkoutBody({ items: [{ productId: product.id, quantity: 1 }] }));

    expect(res.status).toBe(200);
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: res.body.order.id },
    });
    expect(order.source).toBe("STOREFRONT");
  });

  it("rejects an unknown origin with 400 VALIDATION_ERROR", async () => {
    const { store } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const product = await createProduct(store.id);

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(
        checkoutBody({
          items: [{ productId: product.id, quantity: 1 }],
          origin: "BILLBOARD",
        }),
      );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("customer provenance (integration)", () => {
  it("tags checkout-created customers STOREFRONT", async () => {
    const { store } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const product = await createProduct(store.id);

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(checkoutBody({ items: [{ productId: product.id, quantity: 1 }] }));

    expect(res.status).toBe(200);
    const customer = await prisma.customer.findFirstOrThrow({
      where: { storeId: store.id, email: "buyer@example.com" },
    });
    expect(customer.source).toBe("STOREFRONT");
  });

  it("tags POS walk-in customers POS", async () => {
    const { store, token } = await createTenantWithOwner();
    const product = await createProduct(store.id);

    const res = await request(app)
      .post("/api/dashboard/orders")
      .set("Authorization", `Bearer ${token}`)
      .send({
        items: [{ productId: product.id, quantity: 1 }],
        paymentMethod: "CASH",
      });

    expect(res.status).toBe(201);
    const customer = await prisma.customer.findFirstOrThrow({
      where: { storeId: store.id, name: "Walk-in Customer" },
    });
    expect(customer.source).toBe("POS");
  });
});
