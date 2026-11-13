import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../../../app.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { encryptSecret } from "../../lib/secrets.js";
import { signAccessToken } from "../../lib/tokens.js";
import type { $Enums } from "../../../generated/prisma/client.js";

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

let fetchMock: ReturnType<typeof vi.fn>;

async function createTenantWithOwner() {
  const email = `owner-${crypto.randomUUID()}@example.com`;
  const account = await prisma.account.create({
    data: { email, passwordHash: bcrypt.hashSync("password-123", 4) },
  });
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
  const token = signAccessToken({ sub: account.id, storeId: store.id, role: "OWNER" });
  return { account, store, mainBranch, token };
}

async function createStaffMember(storeId: string, role: $Enums.StaffRole = "STAFF") {
  const email = `staff-${crypto.randomUUID()}@example.com`;
  const account = await prisma.account.create({
    data: { email, passwordHash: bcrypt.hashSync("password-123", 4) },
  });
  await prisma.staffMember.create({
    data: { accountId: account.id, storeId, role, permissions: [] },
  });
  const token = signAccessToken({ sub: account.id, storeId, role });
  return { token };
}

/** Attaches an ACTIVE subscription to the store with the given caps and a window around now. */
async function attachSubscription(storeId: string, overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const subscription = await prisma.subscription.create({
    data: {
      storeId,
      tier: "STARTER",
      status: "ACTIVE",
      currentPeriodStart: new Date(now - 2 * 86_400_000),
      currentPeriodEnd: new Date(now + 30 * 86_400_000),
      staffCap: null,
      locationCap: null,
      productCap: null,
      orderCap: null,
      ...overrides,
    },
  });
  await prisma.store.update({
    where: { id: storeId },
    data: { subscriptionId: subscription.id },
  });
  return subscription;
}

async function createProductRow(
  storeId: string,
  name = `Product ${crypto.randomUUID().slice(0, 8)}`,
) {
  return prisma.product.create({
    data: { storeId, name, price: 9.99, quantity: 10, status: "PUBLISHED" },
  });
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
    DELETE FROM "SubscriptionPayment"; DELETE FROM "PaymentCredential"; DELETE FROM "Subscription"; DELETE FROM "Store";
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

describe("GET /api/dashboard/subscriptions/usage (integration)", () => {
  it("returns the plan, live usage counts, period, and customDomain for an active subscription", async () => {
    const { store, token } = await createTenantWithOwner();
    await attachSubscription(store.id, { tier: "PRO", status: "ACTIVE", productCap: 10 });
    await createProductRow(store.id);
    await createProductRow(store.id);
    await prisma.staffMember.create({
      data: {
        accountId: (
          await prisma.account.create({
            data: {
              email: `staff-${crypto.randomUUID()}@example.com`,
              passwordHash: bcrypt.hashSync("x", 4),
            },
          })
        ).id,
        storeId: store.id,
        role: "STAFF",
        permissions: [],
      },
    });
    await prisma.location.create({
      data: { storeId: store.id, name: "Lagos Flagship" },
    });

    const res = await request(app)
      .get("/api/dashboard/subscriptions/usage")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.plan).toMatchObject({ tier: "PRO", status: "ACTIVE", active: true });
    expect(res.body.plan.featureFlags.customDomain).toBe(true);
    expect(res.body.usage).toEqual({ staff: 1, locations: 1, products: 2, orders: 0 });
    expect(res.body.period.start).toMatch(/Z$/);
    expect(res.body.period.end).toMatch(/Z$/);
    expect(res.body.customDomain).toBeNull();
  });

  it("returns the unlimited STARTER view for a store with no subscription", async () => {
    const { token } = await createTenantWithOwner();

    const res = await request(app)
      .get("/api/dashboard/subscriptions/usage")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.plan).toMatchObject({
      tier: "STARTER",
      status: null,
      active: false,
      limits: { staffCap: null, productCap: null, orderCap: null },
    });
  });

  it("requires authentication and rejects staff members", async () => {
    const { store } = await createTenantWithOwner();
    const { token: staffToken } = await createStaffMember(store.id);

    const anon = await request(app).get("/api/dashboard/subscriptions/usage");
    expect(anon.status).toBe(401);

    const staff = await request(app)
      .get("/api/dashboard/subscriptions/usage")
      .set("Authorization", `Bearer ${staffToken}`);
    expect(staff.status).toBe(403);
    expect(staff.body.error.code).toBe("ACCESS_DENIED");
  });

  it("never exposes another tenant's usage (isolation)", async () => {
    const { store: a, token: tokenA } = await createTenantWithOwner();
    const { store: b } = await createTenantWithOwner();
    await attachSubscription(a.id, { productCap: 10 });
    await attachSubscription(b.id, { productCap: 10 });
    await createProductRow(a.id);

    const res = await request(app)
      .get("/api/dashboard/subscriptions/usage")
      .set("Authorization", `Bearer ${tokenA}`);

    expect(res.body.usage.products).toBe(1);
    // Tenant B's product must not leak into A's count.
    const bCount = await prisma.product.count({ where: { storeId: b.id } });
    expect(bCount).toBe(0);
  });
});

describe("GET /api/dashboard/subscriptions/plan (integration)", () => {
  it("returns the resolved plan for the tenant", async () => {
    const { store, token } = await createTenantWithOwner();
    await attachSubscription(store.id, { tier: "PRO", productCap: 25 });

    const res = await request(app)
      .get("/api/dashboard/subscriptions/plan")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tier: "PRO", active: true, limits: { productCap: 25 } });
  });
});

describe("PUT /api/dashboard/subscriptions/custom-domain (integration)", () => {
  it("sets the domain for a tier with the feature flag", async () => {
    const { store, token } = await createTenantWithOwner();
    await attachSubscription(store.id, { tier: "PRO" });

    const res = await request(app)
      .put("/api/dashboard/subscriptions/custom-domain")
      .set("Authorization", `Bearer ${token}`)
      .send({ customDomain: "Shop.Example.com" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ customDomain: "shop.example.com" });
    const row = await prisma.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(row.customDomain).toBe("shop.example.com");
  });

  it("rejects with PLAN_FEATURE_LOCKED on a tier without the flag — direct API bypass attempt", async () => {
    const { store, token } = await createTenantWithOwner();
    await attachSubscription(store.id, { tier: "STARTER" });

    const res = await request(app)
      .put("/api/dashboard/subscriptions/custom-domain")
      .set("Authorization", `Bearer ${token}`)
      .send({ customDomain: "shop.example.com" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("PLAN_FEATURE_LOCKED");
    expect(
      (await prisma.store.findUniqueOrThrow({ where: { id: store.id } })).customDomain,
    ).toBeNull();
  });

  it("rejects with SUBSCRIPTION_INACTIVE when the store has no subscription", async () => {
    const { token } = await createTenantWithOwner();

    const res = await request(app)
      .put("/api/dashboard/subscriptions/custom-domain")
      .set("Authorization", `Bearer ${token}`)
      .send({ customDomain: "shop.example.com" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("SUBSCRIPTION_INACTIVE");
  });

  it("rejects with CUSTOM_DOMAIN_TAKEN when another store owns the domain", async () => {
    const { store: a, token: tokenA } = await createTenantWithOwner();
    const { store: b } = await createTenantWithOwner();
    await attachSubscription(a.id, { tier: "PRO" });
    await attachSubscription(b.id, { tier: "PRO" });
    await prisma.store.update({ where: { id: b.id }, data: { customDomain: "shop.example.com" } });

    const res = await request(app)
      .put("/api/dashboard/subscriptions/custom-domain")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ customDomain: "shop.example.com" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CUSTOM_DOMAIN_TAKEN");
  });

  it("rejects an invalid hostname with 400", async () => {
    const { store, token } = await createTenantWithOwner();
    await attachSubscription(store.id, { tier: "PRO" });

    const res = await request(app)
      .put("/api/dashboard/subscriptions/custom-domain")
      .set("Authorization", `Bearer ${token}`)
      .send({ customDomain: "https://shop.example.com/path" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("productCap over HTTP (integration)", () => {
  it("allows under, rejects at/over with PRODUCT_LIMIT_REACHED and an upgrade message", async () => {
    const { store, token } = await createTenantWithOwner();
    await attachSubscription(store.id, { productCap: 2 });

    const first = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Mug", price: 8 });
    const second = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Cup", price: 6 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    // At the cap now — the third create must fail with an upgrade prompt.
    const third = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Jar", price: 5 });

    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe("PRODUCT_LIMIT_REACHED");
    expect(third.body.error.message).toMatch(/upgrade/i);
    expect(await prisma.product.count({ where: { storeId: store.id, deletedAt: null } })).toBe(2);
  });
});

describe("orderCap over HTTP (integration)", () => {
  async function setupPaystack(storeId: string) {
    await prisma.paymentCredential.create({
      data: {
        storeId,
        provider: "paystack",
        publicKey: "pk_test_1234abcd",
        secretKeyEncrypted: encryptSecret(SECRET_KEY),
      },
    });
  }

  function checkout(storeSubdomain: string, productId: string) {
    return request(app)
      .post(`/api/public/checkout/${storeSubdomain}`)
      .send({
        customer: { name: "Ade Buyer", email: "buyer@example.com", phone: "08012345678" },
        items: [{ productId, quantity: 1 }],
      });
  }

  it("allows under, rejects at/over with ORDER_LIMIT_REACHED and an upgrade message", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    await attachSubscription(store.id, { orderCap: 1 });
    await setupPaystack(store.id);
    const product = await createProductRow(store.id);
    await prisma.branchStock.create({
      data: {
        storeId: store.id,
        branchId: mainBranch.id,
        productId: product.id,
        variantId: null,
        quantity: 10,
      },
    });
    // Owner token unused here — checkout is public by subdomain; it just
    // needs to be authenticated as ANY tenant? No: public checkout uses
    // resolvePublicStore, no bearer required.
    void token;

    const first = await checkout(store.subdomain!, product.id);
    expect(first.status).toBe(200);

    const second = await checkout(store.subdomain!, product.id);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("ORDER_LIMIT_REACHED");
    expect(second.body.error.message).toMatch(/upgrade/i);
    expect(await prisma.order.count({ where: { storeId: store.id } })).toBe(1);
  });
});

describe("subscription billing over HTTP (integration)", () => {
  async function seedPricing() {
    for (const [plan, monthlyPrice, paystackPlanCode] of [
      ["STARTER", 0, "PLN_starter"],
      ["PRO", 4900, "PLN_pro"],
      ["ENTERPRISE", 19000, "PLN_ent"],
    ] as const) {
      await prisma.subscriptionPlanSetting.upsert({
        where: { plan },
        update: { monthlyPrice, paystackPlanCode },
        create: { plan, monthlyPrice, paystackPlanCode },
      });
    }
  }

  it("checkout returns an authorization URL and records a PENDING payment", async () => {
    await seedPricing();
    const { store, token } = await createTenantWithOwner();

    const res = await request(app)
      .post("/api/dashboard/subscriptions/checkout")
      .set("Authorization", `Bearer ${token}`)
      .send({ tier: "PRO" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      tier: "PRO",
      amount: "4900.00",
      authorizationUrl: "https://checkout.paystack.test/session",
    });
    expect(res.body.reference).toMatch(/^sub_/);
    const payment = await prisma.subscriptionPayment.findFirst({
      where: { storeId: store.id },
    });
    expect(payment).not.toBeNull();
    expect(payment!.status).toBe("PENDING");
    expect(payment!.kind).toBe("SUBSCRIPTION");
  });

  it("checkout 409s PRICING_NOT_CONFIGURED when the tier has no plan code", async () => {
    await prisma.subscriptionPlanSetting.upsert({
      where: { plan: "PRO" },
      update: { monthlyPrice: 4900, paystackPlanCode: null },
      create: { plan: "PRO", monthlyPrice: 4900, paystackPlanCode: null },
    });
    const { token } = await createTenantWithOwner();

    const res = await request(app)
      .post("/api/dashboard/subscriptions/checkout")
      .set("Authorization", `Bearer ${token}`)
      .send({ tier: "PRO" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PRICING_NOT_CONFIGURED");
  });

  it("checkout 409s ALREADY_SUBSCRIBED when the store has an active subscription", async () => {
    await seedPricing();
    const { store, token } = await createTenantWithOwner();
    await attachSubscription(store.id, { tier: "PRO" });

    const res = await request(app)
      .post("/api/dashboard/subscriptions/checkout")
      .set("Authorization", `Bearer ${token}`)
      .send({ tier: "PRO" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ALREADY_SUBSCRIBED");
  });

  it("upgrade charges a prorated diff and records a PENDING UPGRADE payment", async () => {
    await seedPricing();
    const { store, token } = await createTenantWithOwner();
    await attachSubscription(store.id, { tier: "PRO" });

    const res = await request(app)
      .post("/api/dashboard/subscriptions/upgrade")
      .set("Authorization", `Bearer ${token}`)
      .send({ tier: "ENTERPRISE" });

    expect(res.status).toBe(201);
    expect(res.body.tier).toBe("ENTERPRISE");
    expect(res.body.effectiveImmediately).toBe(true);
    expect(res.body.reference).toMatch(/^upg_/);
    const payment = await prisma.subscriptionPayment.findFirst({
      where: { storeId: store.id, kind: "UPGRADE" },
    });
    expect(payment).not.toBeNull();
    expect(payment!.status).toBe("PENDING");
  });

  it("upgrade 409s UPGRADE_NOT_HIGHER when the target is cheaper", async () => {
    await seedPricing();
    const { store, token } = await createTenantWithOwner();
    await attachSubscription(store.id, { tier: "ENTERPRISE" });

    const res = await request(app)
      .post("/api/dashboard/subscriptions/upgrade")
      .set("Authorization", `Bearer ${token}`)
      .send({ tier: "PRO" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("UPGRADE_NOT_HIGHER");
  });

  it("downgrade schedules a deferred change and returns warnings", async () => {
    await seedPricing();
    const { store, token } = await createTenantWithOwner();
    await attachSubscription(store.id, { tier: "PRO" });

    const res = await request(app)
      .post("/api/dashboard/subscriptions/downgrade")
      .set("Authorization", `Bearer ${token}`)
      .send({ tier: "STARTER" });

    expect(res.status).toBe(200);
    expect(res.body.targetTier).toBe("STARTER");
    expect(res.body.effectiveAt).toBeDefined();
    expect(Array.isArray(res.body.warnings)).toBe(true);
    const sub = await prisma.subscription.findFirst({
      where: { storeId: store.id },
    });
    expect(sub!.pendingDowngradeTier).toBe("STARTER");
  });

  it("downgrade preview returns warnings without changing anything", async () => {
    await seedPricing();
    const { store, token } = await createTenantWithOwner();
    await attachSubscription(store.id, { tier: "PRO" });

    const res = await request(app)
      .get("/api/dashboard/subscriptions/downgrade/preview?tier=STARTER")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.targetTier).toBe("STARTER");
    expect(Array.isArray(res.body.warnings)).toBe(true);
    const sub = await prisma.subscription.findFirst({
      where: { storeId: store.id },
    });
    expect(sub!.pendingDowngradeTier).toBeNull();
  });

  it("downgrade 409s DOWNGRADE_NOT_LOWER when the target is pricier", async () => {
    await seedPricing();
    const { store, token } = await createTenantWithOwner();
    await attachSubscription(store.id, { tier: "STARTER" });

    const res = await request(app)
      .post("/api/dashboard/subscriptions/downgrade")
      .set("Authorization", `Bearer ${token}`)
      .send({ tier: "PRO" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DOWNGRADE_NOT_LOWER");
  });

  it("cancel disables the Paystack subscription and marks the store CANCELLED", async () => {
    await seedPricing();
    const { store, token } = await createTenantWithOwner();
    const sub = await attachSubscription(store.id, { tier: "PRO" });
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { paystackSubscriptionCode: "SUB_1", paystackEmailToken: "tok_1" },
    });

    const res = await request(app)
      .post("/api/dashboard/subscriptions/cancel")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const after = await prisma.subscription.findFirstOrThrow({ where: { storeId: store.id } });
    expect(after.status).toBe("CANCELLED");
  });

  it("lists and fetches subscription payment history", async () => {
    await seedPricing();
    const { store, token } = await createTenantWithOwner();
    const payment = await prisma.subscriptionPayment.create({
      data: {
        storeId: store.id,
        tier: "PRO",
        kind: "SUBSCRIPTION",
        status: "PAID",
        reference: "sub_HIST1",
        amount: 4900,
        paidAt: new Date(),
      },
    });

    const listRes = await request(app)
      .get("/api/dashboard/subscriptions/payments")
      .set("Authorization", `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.items).toHaveLength(1);

    const detailRes = await request(app)
      .get(`/api/dashboard/subscriptions/payments/${payment.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.reference).toBe("sub_HIST1");
  });

  it("rejects billing writes for non-owner staff (owner-only)", async () => {
    await seedPricing();
    const { store } = await createTenantWithOwner();
    const { token } = await createStaffMember(store.id, "STAFF");

    const res = await request(app)
      .post("/api/dashboard/subscriptions/checkout")
      .set("Authorization", `Bearer ${token}`)
      .send({ tier: "PRO" });

    expect(res.status).toBe(403);
  });
});
