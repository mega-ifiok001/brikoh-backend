import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../../../app.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { encryptSecret } from "../../lib/secrets.js";

const prisma = createPrismaClient(process.env.TEST_DATABASE_URL);

const SECRET_KEY = "sk_test_1234abcd5678efgh";

function paystackInitiateSuccess() {
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

function sign(rawBody: string): string {
  return createHmac("sha512", SECRET_KEY).update(rawBody).digest("hex");
}

function successEvent(reference: string, eventId: string): string {
  return JSON.stringify({
    event: "charge.success",
    data: { id: eventId, reference, status: "success" },
  });
}

function failedEvent(reference: string, eventId: string): string {
  return JSON.stringify({
    event: "charge.failed",
    data: { id: eventId, reference, status: "failed" },
  });
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
  const mainBranch = await prisma.branch.create({
    data: { storeId: store.id, name: "Main Branch", address: "Lagos, Nigeria" },
  });
  await prisma.store.update({ where: { id: store.id }, data: { defaultBranchId: mainBranch.id } });
  await prisma.owner.create({ data: { accountId: account.id, storeId: store.id } });
  return { account, email, store, mainBranch };
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
      // Checkout only sees PUBLISHED products; helper rows are buyable
      // by default, DRAFT is set explicitly when testing the gate.
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

/** Runs the real checkout flow (with stubbed Paystack init) and returns the pending order. */
async function checkoutOrder(
  storeSubdomain: string | null,
  items: { productId: string; quantity: number; variantId?: string }[],
) {
  if (storeSubdomain === null) {
    throw new Error("test store has no subdomain");
  }
  const res = await request(app)
    .post(`/api/public/checkout/${storeSubdomain}`)
    .send({
      customer: { name: "Ade Buyer", email: "buyer@example.com", phone: "08012345678" },
      items,
    });
  expect(res.status).toBe(200);
  const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.order.id } });
  return { order, reference: res.body.payment.reference as string };
}

function sendWebhook(rawBody: string, signature = sign(rawBody)) {
  return request(app)
    .post("/api/webhooks/paystack")
    .set("Content-Type", "application/json")
    .set("x-paystack-signature", signature)
    .send(rawBody);
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
  fetchMock = vi.fn(async () => paystackInitiateSuccess());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/webhooks/paystack (integration)", () => {
  it("marks the order PAID and decrements stock with SALE ledger entries on charge.success", async () => {
    const { store } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const product = await createProduct(store.id);
    const { order, reference } = await checkoutOrder(store.subdomain, [
      { productId: product.id, quantity: 2 },
    ]);
    expect(order.status).toBe("PENDING");

    const rawBody = successEvent(reference, `evt-${crypto.randomUUID()}`);
    const res = await sendWebhook(rawBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true });

    const paid = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(paid.status).toBe("PAID");

    const productAfter = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(productAfter.quantity).toBe(8);

    const entries = await prisma.stockLedgerEntry.findMany({
      where: { storeId: store.id },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      productId: product.id,
      quantityChange: -2,
      reason: "SALE",
      performedByStaffId: null,
    });

    const events = await prisma.webhookEvent.findMany({ where: { storeId: store.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "PROCESSED", provider: "paystack" });
    expect(events[0]!.processedAt).not.toBeNull();
    expect(events[0]!.payload).toMatchObject({ event: "charge.success" });
  });

  it("decrements the exact variant on charge.success: variant stock falls, product quantity stays 0", async () => {
    const { store, mainBranch } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const product = await prisma.product.create({
      data: {
        storeId: store.id,
        name: "Shirt",
        price: 15,
        quantity: 0,
        status: "PUBLISHED",
        variants: {
          create: [
            { storeId: store.id, name: "M", sellingPrice: 18, quantity: 5 },
            { storeId: store.id, name: "L", quantity: 9 },
          ],
        },
      },
      include: { variants: true },
    });
    // The branch-stock invariant: one BranchStock row per (branch,
    // product, variant), mirroring the raw variant quantities.
    for (const variant of product.variants) {
      await prisma.branchStock.create({
        data: {
          storeId: store.id,
          branchId: mainBranch.id,
          productId: product.id,
          variantId: variant.id,
          quantity: variant.quantity,
        },
      });
    }
    const variantM = product.variants.find((v) => v.name === "M")!;

    const { order, reference } = await checkoutOrder(store.subdomain, [
      { productId: product.id, variantId: variantM.id, quantity: 2 },
    ]);
    expect(order.status).toBe("PENDING");

    const rawBody = successEvent(reference, `evt-${crypto.randomUUID()}`);
    const res = await sendWebhook(rawBody);
    expect(res.status).toBe(200);

    const variantAfter = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variantM.id },
    });
    expect(variantAfter.quantity).toBe(3);
    const siblingAfter = await prisma.productVariant.findUniqueOrThrow({
      where: { id: product.variants.find((v) => v.name === "L")!.id },
    });
    expect(siblingAfter.quantity).toBe(9);
    const productAfter = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(productAfter.quantity).toBe(0);

    const entries = await prisma.stockLedgerEntry.findMany({ where: { storeId: store.id } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      productId: product.id,
      variantId: variantM.id,
      quantityChange: -2,
      reason: "SALE",
    });

    const lineItems = await prisma.orderLineItem.findMany({
      where: { orderId: order.id },
    });
    expect(lineItems).toHaveLength(1);
    expect(lineItems[0]!.variantId).toBe(variantM.id);
    expect(lineItems[0]!.unitPriceAtPurchase.toString()).toBe("18");
  });

  it("is idempotent: a redelivered event returns 200 and never decrements twice", async () => {
    const { store } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const product = await createProduct(store.id);
    const { order, reference } = await checkoutOrder(store.subdomain, [
      { productId: product.id, quantity: 2 },
    ]);
    const rawBody = successEvent(reference, "evt-dup-1");

    const first = await sendWebhook(rawBody);
    const second = await sendWebhook(rawBody);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await prisma.webhookEvent.count({ where: { storeId: store.id } })).toBe(1);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).quantity).toBe(
      8,
    );
    expect(await prisma.stockLedgerEntry.count({ where: { storeId: store.id } })).toBe(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
  });

  it("applies each store's webhook only to its own order and stock (cross-tenant)", async () => {
    const { store: storeA } = await createTenantWithOwner();
    const { store: storeB } = await createTenantWithOwner();
    await configurePaystack(storeA.id);
    await configurePaystack(storeB.id);
    const productA = await createProduct(storeA.id, { quantity: 10 });
    const productB = await createProduct(storeB.id, { quantity: 10 });

    // Two full paid flows — one per tenant — through the real pipeline.
    const paidA = await checkoutOrder(storeA.subdomain, [{ productId: productA.id, quantity: 2 }]);
    await sendWebhook(successEvent(paidA.reference, `evt-a-${crypto.randomUUID()}`));
    const paidB = await checkoutOrder(storeB.subdomain, [{ productId: productB.id, quantity: 3 }]);
    await sendWebhook(successEvent(paidB.reference, `evt-b-${crypto.randomUUID()}`));

    const afterA = await prisma.product.findUniqueOrThrow({ where: { id: productA.id } });
    const afterB = await prisma.product.findUniqueOrThrow({ where: { id: productB.id } });
    expect(afterA.quantity).toBe(8); // 10 - 2 (A's event only)
    expect(afterB.quantity).toBe(7); // 10 - 3 (B's event only)
    expect(await prisma.stockLedgerEntry.count({ where: { storeId: storeA.id } })).toBeGreaterThan(
      0,
    );
    expect(await prisma.stockLedgerEntry.count({ where: { storeId: storeB.id } })).toBeGreaterThan(
      0,
    );
  });

  it("rejects a tampered payload with 401 and changes nothing", async () => {
    const { store } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const product = await createProduct(store.id);
    const { order, reference } = await checkoutOrder(store.subdomain, [
      { productId: product.id, quantity: 2 },
    ]);
    const rawBody = successEvent(reference, "evt-tampered");

    const res = await sendWebhook(
      rawBody,
      sign(rawBody.replace("charge.success", "charge.failed")),
    );

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_SIGNATURE");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "PENDING",
    );
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).quantity).toBe(
      10,
    );
    expect(await prisma.webhookEvent.count({ where: { storeId: store.id } })).toBe(0);
  });

  it("marks the order FAILED on charge.failed and never touches stock", async () => {
    const { store } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const product = await createProduct(store.id);
    const { order, reference } = await checkoutOrder(store.subdomain, [
      { productId: product.id, quantity: 2 },
    ]);

    const res = await sendWebhook(failedEvent(reference, "evt-failed-1"));

    expect(res.status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "FAILED",
    );
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).quantity).toBe(
      10,
    );
    expect(await prisma.stockLedgerEntry.count({ where: { storeId: store.id } })).toBe(0);
  });

  it("acknowledges unknown event types without recording anything", async () => {
    const { store } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const product = await createProduct(store.id);
    const { order, reference } = await checkoutOrder(store.subdomain, [
      { productId: product.id, quantity: 1 },
    ]);

    const rawBody = JSON.stringify({
      event: "invoice.created",
      data: { id: "evt-invoice", reference, status: "success" },
    });
    const res = await sendWebhook(rawBody);

    expect(res.status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "PENDING",
    );
    expect(await prisma.webhookEvent.count({ where: { storeId: store.id } })).toBe(0);
    void product;
  });

  it("returns 404 for an unknown payment reference", async () => {
    const res = await sendWebhook(successEvent("ord_nonexistent", "evt-unknown"));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ORDER_NOT_FOUND");
  });

  it("returns 400 for a malformed JSON body", async () => {
    const res = await sendWebhook("not json at all", sign("not json at all"));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when the payload lacks data.id or reference", async () => {
    const res = await sendWebhook(JSON.stringify({ event: "charge.success", data: {} }));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("decrements every line item of a multi-product order in one transaction", async () => {
    const { store } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const coffee = await createProduct(store.id, { quantity: 20 });
    const honey = await createProduct(store.id, { quantity: 15 });
    const { order, reference } = await checkoutOrder(store.subdomain, [
      { productId: coffee.id, quantity: 3 },
      { productId: honey.id, quantity: 4 },
    ]);

    const res = await sendWebhook(successEvent(reference, "evt-multi-1"));

    expect(res.status).toBe(200);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: coffee.id } })).quantity).toBe(
      17,
    );
    expect((await prisma.product.findUniqueOrThrow({ where: { id: honey.id } })).quantity).toBe(11);

    const entries = await prisma.stockLedgerEntry.findMany({ where: { storeId: store.id } });
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.quantityChange).sort()).toEqual([-3, -4]);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
  });

  it("rolls everything back with 409 when stock ran out after initiation (oversold)", async () => {
    const { store, mainBranch } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const product = await createProduct(store.id, { quantity: 2 });
    const { order, reference } = await checkoutOrder(store.subdomain, [
      { productId: product.id, quantity: 2 },
    ]);
    // Simulate a concurrent sale consuming stock after initiation — on
    // BOTH the cache and the authoritative BranchStock row.
    await prisma.product.update({ where: { id: product.id }, data: { quantity: 1 } });
    await prisma.branchStock.updateMany({
      where: { branchId: mainBranch.id, productId: product.id, variantId: null },
      data: { quantity: 1 },
    });

    const res = await sendWebhook(successEvent(reference, "evt-oversold"));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INSUFFICIENT_STOCK");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "PENDING",
    );
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).quantity).toBe(
      1,
    );
    expect(await prisma.stockLedgerEntry.count({ where: { storeId: store.id } })).toBe(0);
    expect(await prisma.webhookEvent.count({ where: { storeId: store.id } })).toBe(0);
  });

  it("records the event but does not double-decrement when the order is already PAID", async () => {
    const { store, mainBranch } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const product = await createProduct(store.id);
    const { order, reference } = await checkoutOrder(store.subdomain, [
      { productId: product.id, quantity: 2 },
    ]);
    // Simulate an earlier processing whose WebhookEvent row was lost:
    // order PAID and stock already moved, no event recorded.
    await prisma.order.update({ where: { id: order.id }, data: { status: "PAID" } });
    await prisma.product.update({
      where: { id: product.id },
      data: { quantity: { decrement: 2 } },
    });
    await prisma.stockLedgerEntry.create({
      data: {
        storeId: store.id,
        branchId: mainBranch.id,
        productId: product.id,
        quantityChange: -2,
        reason: "SALE",
        performedByStaffId: null,
      },
    });

    const res = await sendWebhook(successEvent(reference, "evt-already-paid"));

    expect(res.status).toBe(200);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).quantity).toBe(
      8,
    );
    expect(await prisma.stockLedgerEntry.count({ where: { storeId: store.id } })).toBe(1);
    expect(await prisma.webhookEvent.count({ where: { storeId: store.id } })).toBe(1);
  });

  it("returns 409 PAYMENT_NOT_CONFIGURED when the store's credentials were deleted", async () => {
    const { store } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const product = await createProduct(store.id);
    const { reference } = await checkoutOrder(store.subdomain, [
      { productId: product.id, quantity: 1 },
    ]);
    await prisma.paymentCredential.deleteMany({ where: { storeId: store.id } });

    const res = await sendWebhook(successEvent(reference, "evt-no-cred"));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PAYMENT_NOT_CONFIGURED");
    expect(await prisma.webhookEvent.count({ where: { storeId: store.id } })).toBe(0);
  });
});
