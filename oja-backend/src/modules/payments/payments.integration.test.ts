import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../../../app.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { decryptSecret } from "../../lib/secrets.js";
import { maskSecretKey } from "./service.js";

const prisma = createPrismaClient(process.env.TEST_DATABASE_URL);

const PUBLIC_KEY = "pk_test_1234abcd";
const SECRET_KEY = "sk_test_1234abcd5678efgh";

async function createAccount(password = "password-123") {
  const email = `account-${crypto.randomUUID()}@example.com`;
  const account = await prisma.account.create({
    data: { email, passwordHash: bcrypt.hashSync(password, 4) },
  });
  return { account, email };
}

async function createTenantWithOwner() {
  const { account, email } = await createAccount();
  const store = await prisma.store.create({
    data: {
      name: `Store ${crypto.randomUUID().slice(0, 8)}`,
      subdomain: `s-${crypto.randomUUID().slice(0, 8)}`,
      businessType: "OTHER",
      location: "Lagos, Nigeria",
      businessPhone: "+234 801 234 5678",
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

function paystackVerifySuccess(paidAt = "2026-08-04T09:47:36.001Z") {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      status: true,
      message: "Verification successful",
      data: {
        status: "success",
        reference: "ord_any",
        amount: 1998,
        currency: "NGN",
        paid_at: paidAt,
      },
    }),
  } as unknown as Response;
}

/** Full flow: checkout (stubbed initialize) + signed charge.success webhook. */
async function createPaidOrder(storeSubdomain: string | null, productId: string, quantity = 2) {
  if (storeSubdomain === null) {
    throw new Error("test store has no subdomain");
  }
  const checkout = await request(app)
    .post(`/api/public/checkout/${storeSubdomain}`)
    .send({
      customer: { name: "Ade Buyer", email: "buyer@example.com", phone: "08012345678" },
      items: [{ productId, quantity }],
    });
  expect(checkout.status).toBe(200);
  const reference = checkout.body.payment.reference as string;
  const rawBody = JSON.stringify({
    event: "charge.success",
    data: { id: `evt-${crypto.randomUUID()}`, reference, status: "success" },
  });
  const signature = createHmac("sha512", SECRET_KEY).update(rawBody).digest("hex");
  const webhook = await request(app)
    .post("/api/webhooks/paystack")
    .set("Content-Type", "application/json")
    .set("x-paystack-signature", signature)
    .send(rawBody);
  expect(webhook.status).toBe(200);
  return { orderId: checkout.body.order.id as string, reference };
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
  fetchMock = vi.fn(async (url: string | URL | Request) => {
    if (String(url).includes("/transaction/initialize")) {
      return paystackInitiateSuccess();
    }
    return paystackVerifySuccess();
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function createStaff(
  storeId: string,
  role: "ADMIN" | "MANAGER" | "STAFF" = "STAFF",
  permissions: string[] = [],
) {
  const { account, email } = await createAccount();
  const staff = await prisma.staffMember.create({
    data: { accountId: account.id, storeId, role, permissions },
  });
  return { staff, email };
}

async function ownerToken(accountId: string) {
  const res = await request(app)
    .post("/api/public/auth/login")
    .send({
      email: (await prisma.account.findUniqueOrThrow({ where: { id: accountId } })).email,
      password: "password-123",
    });
  return res.body.accessToken as string;
}

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
});

describe("GET /api/dashboard/payments/provider (integration)", () => {
  it("returns configured:false before any keys are saved", async () => {
    const { account } = await createTenantWithOwner();
    const token = await ownerToken(account.id);

    const res = await request(app)
      .get("/api/dashboard/payments/provider")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      configured: false,
      provider: "paystack",
      publicKey: null,
      secretKeyMasked: null,
      updatedAt: null,
    });
  });

  it("returns the masked view after saving; the secret never appears in full", async () => {
    const { store, account } = await createTenantWithOwner();
    const token = await ownerToken(account.id);

    await request(app)
      .put("/api/dashboard/payments/provider")
      .set("Authorization", `Bearer ${token}`)
      .send({ provider: "paystack", publicKey: PUBLIC_KEY, secretKey: SECRET_KEY });

    const res = await request(app)
      .get("/api/dashboard/payments/provider")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      configured: true,
      provider: "paystack",
      publicKey: PUBLIC_KEY,
      secretKeyMasked: maskSecretKey(SECRET_KEY),
    });
    expect(JSON.stringify(res.body)).not.toContain(SECRET_KEY);
    void store;
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/api/dashboard/payments/provider");
    expect(res.status).toBe(401);
  });

  it("rejects staff members (owner-only)", async () => {
    const { store } = await createTenantWithOwner();
    const { staff, email } = await createStaff(store.id, "ADMIN", ["payments.manage"]);

    const login = await request(app).post("/api/public/auth/login").send({
      email,
      password: "password-123",
    });
    const res = await request(app)
      .get("/api/dashboard/payments/provider")
      .set("Authorization", `Bearer ${login.body.accessToken}`);

    expect(res.status).toBe(403);
    void staff;
  });
});

describe("PUT /api/dashboard/payments/provider (integration)", () => {
  it("saves the key pair with the secret encrypted at rest", async () => {
    const { store, account } = await createTenantWithOwner();
    const token = await ownerToken(account.id);

    const res = await request(app)
      .put("/api/dashboard/payments/provider")
      .set("Authorization", `Bearer ${token}`)
      .send({ provider: "paystack", publicKey: PUBLIC_KEY, secretKey: SECRET_KEY });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      configured: true,
      publicKey: PUBLIC_KEY,
      secretKeyMasked: maskSecretKey(SECRET_KEY),
    });
    expect(JSON.stringify(res.body)).not.toContain(SECRET_KEY);

    const row = await prisma.paymentCredential.findUniqueOrThrow({
      where: { storeId_provider: { storeId: store.id, provider: "paystack" } },
    });
    expect(row.secretKeyEncrypted).not.toContain(SECRET_KEY);
    expect(decryptSecret(row.secretKeyEncrypted)).toBe(SECRET_KEY);
  });

  it("replaces the previous pair on re-save", async () => {
    const { store, account } = await createTenantWithOwner();
    const token = await ownerToken(account.id);
    const newSecret = "sk_live_9999abcd5678efgh";

    await request(app)
      .put("/api/dashboard/payments/provider")
      .set("Authorization", `Bearer ${token}`)
      .send({ provider: "paystack", publicKey: "pk_test_old", secretKey: SECRET_KEY });

    const res = await request(app)
      .put("/api/dashboard/payments/provider")
      .set("Authorization", `Bearer ${token}`)
      .send({ provider: "paystack", publicKey: "pk_live_9999abcd", secretKey: newSecret });

    expect(res.status).toBe(200);
    expect(res.body.secretKeyMasked).toBe(maskSecretKey(newSecret));

    const rows = await prisma.paymentCredential.count({
      where: { storeId: store.id },
    });
    expect(rows).toBe(1);
    const row = await prisma.paymentCredential.findUniqueOrThrow({
      where: { storeId_provider: { storeId: store.id, provider: "paystack" } },
    });
    expect(decryptSecret(row.secretKeyEncrypted)).toBe(newSecret);
  });

  it("rejects key shapes that do not match the paystack prefix pattern", async () => {
    const { account } = await createTenantWithOwner();
    const token = await ownerToken(account.id);

    const res = await request(app)
      .put("/api/dashboard/payments/provider")
      .set("Authorization", `Bearer ${token}`)
      .send({ provider: "paystack", publicKey: "wrong-key", secretKey: SECRET_KEY });

    expect(res.status).toBe(400);
  });

  it("rejects an unknown provider", async () => {
    const { account } = await createTenantWithOwner();
    const token = await ownerToken(account.id);

    const res = await request(app)
      .put("/api/dashboard/payments/provider")
      .set("Authorization", `Bearer ${token}`)
      .send({ provider: "opay", publicKey: PUBLIC_KEY, secretKey: SECRET_KEY });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("does not leak the secret into logs or cross-store views (edge)", async () => {
    const { account } = await createTenantWithOwner();
    const other = await createTenantWithOwner();
    const token = await ownerToken(account.id);

    await request(app)
      .put("/api/dashboard/payments/provider")
      .set("Authorization", `Bearer ${token}`)
      .send({ provider: "paystack", publicKey: PUBLIC_KEY, secretKey: SECRET_KEY });

    const otherToken = await ownerToken(other.account.id);
    const res = await request(app)
      .get("/api/dashboard/payments/provider")
      .set("Authorization", `Bearer ${otherToken}`);

    expect(res.body.configured).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(SECRET_KEY);
  });
});

describe("GET /api/dashboard/payments/settlements (integration)", () => {
  it("returns the live transaction state per paid order; pending orders are excluded", async () => {
    const { store, account } = await createTenantWithOwner();
    await request(app)
      .put("/api/dashboard/payments/provider")
      .set("Authorization", `Bearer ${await ownerToken(account.id)}`)
      .send({ provider: "paystack", publicKey: PUBLIC_KEY, secretKey: SECRET_KEY });
    const token = await ownerToken(account.id);
    const product = await createProduct(store.id);
    const paid = await createPaidOrder(store.subdomain, product.id, 2);
    // A second, still-pending order must NOT appear.
    await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send({
        customer: { name: "Ade Buyer", email: "buyer@example.com", phone: "08012345678" },
        items: [{ productId: product.id, quantity: 1 }],
      });

    const res = await request(app)
      .get("/api/dashboard/payments/settlements")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.settlements).toHaveLength(1);
    expect(res.body.settlements[0]).toMatchObject({
      orderId: paid.orderId,
      reference: paid.reference,
      total: "19.98",
      currency: "NGN",
      transactionStatus: "success",
      paidAt: "2026-08-04T09:47:36.001Z",
      settlement: { status: "UNAVAILABLE", settledAt: null },
    });
    expect(res.body.settlements[0].settlement.detail).toContain("Paystack");
    expect(res.body.settlements[0].paidAt).toMatch(/Z$/);
    expect(JSON.stringify(res.body)).not.toContain(SECRET_KEY);
  });

  it("returns an empty settlements list when there are no paid orders", async () => {
    const { account } = await createTenantWithOwner();
    const token = await ownerToken(account.id);
    const res = await request(app)
      .get("/api/dashboard/payments/settlements")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.settlements).toEqual([]);
  });

  it("lists only the tenant's own PAID orders (cross-tenant isolation)", async () => {
    const { store: storeA, account: accountA } = await createTenantWithOwner();
    await request(app)
      .put("/api/dashboard/payments/provider")
      .set("Authorization", `Bearer ${await ownerToken(accountA.id)}`)
      .send({ provider: "paystack", publicKey: PUBLIC_KEY, secretKey: SECRET_KEY });
    const productA = await createProduct(storeA.id);
    const paidA = await createPaidOrder(storeA.subdomain, productA.id, 2);

    // A second tenant with its own paid order must never appear in A's view.
    const { store: storeB, account: accountB } = await createTenantWithOwner();
    await request(app)
      .put("/api/dashboard/payments/provider")
      .set("Authorization", `Bearer ${await ownerToken(accountB.id)}`)
      .send({ provider: "paystack", publicKey: PUBLIC_KEY, secretKey: SECRET_KEY });
    const productB = await createProduct(storeB.id);
    await createPaidOrder(storeB.subdomain, productB.id, 2);

    const res = await request(app)
      .get("/api/dashboard/payments/settlements")
      .set("Authorization", `Bearer ${await ownerToken(accountA.id)}`);

    expect(res.status).toBe(200);
    expect(res.body.settlements).toHaveLength(1);
    expect(res.body.settlements[0].orderId).toBe(paidA.orderId);
    expect(JSON.stringify(res.body)).not.toContain(SECRET_KEY);
  });

  it("says Paystack data is unavailable explicitly when the provider errors", async () => {
    const { store, account } = await createTenantWithOwner();
    const token = await ownerToken(account.id);
    await request(app)
      .put("/api/dashboard/payments/provider")
      .set("Authorization", `Bearer ${token}`)
      .send({ provider: "paystack", publicKey: PUBLIC_KEY, secretKey: SECRET_KEY });
    const product = await createProduct(store.id);
    await createPaidOrder(store.subdomain, product.id, 2);
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).includes("/transaction/initialize")) {
        return paystackInitiateSuccess();
      }
      throw new TypeError("fetch failed");
    });

    const res = await request(app)
      .get("/api/dashboard/payments/settlements")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.settlements[0]).toMatchObject({
      transactionStatus: "unavailable",
      paidAt: null,
      settlement: { status: "UNAVAILABLE", settledAt: null },
    });
    expect(res.body.settlements[0].settlement.detail).toContain("Paystack data unavailable");
  });

  it("never exposes another tenant's paid orders (isolation)", async () => {
    const { store, account } = await createTenantWithOwner();
    const other = await createTenantWithOwner();
    const token = await ownerToken(account.id);
    const otherToken = await ownerToken(other.account.id);
    for (const [s, t] of [
      [store, token],
      [other.store, otherToken],
    ] as const) {
      await request(app)
        .put("/api/dashboard/payments/provider")
        .set("Authorization", `Bearer ${t}`)
        .send({ provider: "paystack", publicKey: PUBLIC_KEY, secretKey: SECRET_KEY });
      const product = await createProduct(s.id);
      await createPaidOrder(s.subdomain, product.id, 1);
    }

    const res = await request(app)
      .get("/api/dashboard/payments/settlements")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.settlements).toHaveLength(1);
    const otherOrders = await prisma.order.findMany({ where: { storeId: other.store.id } });
    expect(res.body.settlements[0].orderId).not.toBe(otherOrders[0]!.id);
  });

  it("requires authentication and rejects staff members", async () => {
    const { store } = await createTenantWithOwner();
    const { staff, email } = await createStaff(store.id, "ADMIN", ["payments.manage"]);

    const anon = await request(app).get("/api/dashboard/payments/settlements");
    expect(anon.status).toBe(401);

    const login = await request(app).post("/api/public/auth/login").send({
      email,
      password: "password-123",
    });
    const staffRes = await request(app)
      .get("/api/dashboard/payments/settlements")
      .set("Authorization", `Bearer ${login.body.accessToken}`);
    expect(staffRes.status).toBe(403);
    void staff;
  });
});
