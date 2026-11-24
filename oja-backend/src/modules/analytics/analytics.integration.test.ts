import { beforeEach, afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../../../app.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { signAccessToken } from "../../lib/tokens.js";
import type { $Enums } from "../../../generated/prisma/client.js";

const prisma = createPrismaClient(process.env.TEST_DATABASE_URL);

const RANGE_START = "2026-08-03T00:00:00.000Z";
const SELECTED_DATE = "2026-08-03";

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
  return { account, store, token };
}

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

async function createStaffMember(
  storeId: string,
  options: { firstName: string; lastName: string; permissions?: string[] } = {
    firstName: "Staff",
    lastName: "One",
  },
) {
  const account = await prisma.account.create({
    data: {
      email: `staff-${crypto.randomUUID()}@example.com`,
      passwordHash: bcrypt.hashSync("password-123", 4),
      firstName: options.firstName,
      lastName: options.lastName,
    },
  });
  const staff = await prisma.staffMember.create({
    data: { accountId: account.id, storeId, role: "STAFF", permissions: options.permissions ?? [] },
  });
  return { staff, account };
}

async function createProductRow(storeId: string, name: string, price: number) {
  return prisma.product.create({
    data: { storeId, name, price, quantity: 100 },
  });
}

async function createCustomer(storeId: string) {
  return prisma.customer.create({
    data: { storeId, name: "Test Customer", email: `cust-${crypto.randomUUID()}@example.com` },
  });
}

async function createOrderRow(
  storeId: string,
  options: {
    createdAt: string;
    status: $Enums.OrderStatus;
    total: number;
    soldByStaffId?: string;
    source?: $Enums.OrderSource;
    lines: { productId: string; quantity: number; unitPriceAtPurchase: number }[];
  },
) {
  const customer = await createCustomer(storeId);
  const { defaultBranchId } = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    select: { defaultBranchId: true },
  });
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.create({
      data: {
        storeId,
        customerId: customer.id,
        branchId: defaultBranchId!,
        orderNumber: `ORD-${crypto.randomUUID().slice(0, 8)}`,
        status: options.status,
        total: options.total,
        createdAt: new Date(options.createdAt),
        soldByStaffId: options.soldByStaffId,
        source: options.source,
      },
    });
    if (options.lines.length > 0) {
      await tx.orderLineItem.createMany({
        data: options.lines.map((line) => ({
          storeId,
          orderId: order.id,
          productId: line.productId,
          quantity: line.quantity,
          unitPriceAtPurchase: line.unitPriceAtPurchase,
        })),
      });
    }
    return order;
  });
}

async function createLedgerRow(
  storeId: string,
  options: {
    staffId: string;
    productId: string;
    quantityChange: number;
    reason: $Enums.StockReason;
  },
) {
  const { defaultBranchId } = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    select: { defaultBranchId: true },
  });
  return prisma.stockLedgerEntry.create({
    data: {
      storeId,
      branchId: defaultBranchId!,
      productId: options.productId,
      quantityChange: options.quantityChange,
      reason: options.reason,
      performedByStaffId: options.staffId,
      // The fixture's analytics window is [Aug 3, Aug 7) — pin the row
      // inside it so the seeded "inventory activity" is counted regardless
      // of when the suite actually runs.
      createdAt: new Date("2026-08-04T12:00:00.000Z"),
    },
  });
}

/** The known dataset: exact orders on exact UTC dates with exact totals. */
async function seedStoreA(storeId: string) {
  const chai = await createProductRow(storeId, "Chai", 10.0);
  const muffin = await createProductRow(storeId, "Muffin", 5.0);
  const bagel = await createProductRow(storeId, "Bagel", 3.5);
  const ada = await createStaffMember(storeId, { firstName: "Ada", lastName: "Obi" });
  const ben = await createStaffMember(storeId, { firstName: "Ben", lastName: "Yusuf" });
  const cara = await createStaffMember(storeId, { firstName: "Cara", lastName: "Li" });

  await createOrderRow(storeId, {
    createdAt: "2026-08-03T09:30:00.000Z",
    status: "PAID",
    total: 25.0,
    soldByStaffId: ada.staff.id,
    lines: [
      { productId: chai.id, quantity: 2, unitPriceAtPurchase: 10.0 },
      { productId: muffin.id, quantity: 1, unitPriceAtPurchase: 5.0 },
    ],
  });
  await createOrderRow(storeId, {
    createdAt: "2026-08-03T23:59:59.000Z",
    status: "PAID",
    total: 7.0,
    lines: [{ productId: bagel.id, quantity: 2, unitPriceAtPurchase: 3.5 }],
  });
  // Exactly at range start — must be included (start is inclusive).
  await createOrderRow(storeId, {
    createdAt: "2026-08-03T00:00:00.000Z",
    status: "PAID",
    total: 3.5,
    lines: [{ productId: bagel.id, quantity: 1, unitPriceAtPurchase: 3.5 }],
  });
  await createOrderRow(storeId, {
    createdAt: "2026-08-04T12:00:00.000Z",
    status: "PAID",
    total: 10.0,
    soldByStaffId: ben.staff.id,
    lines: [{ productId: muffin.id, quantity: 2, unitPriceAtPurchase: 5.0 }],
  });
  await createOrderRow(storeId, {
    createdAt: "2026-08-05T00:00:00.000Z",
    status: "SHIPPED",
    total: 20.0,
    soldByStaffId: ada.staff.id,
    lines: [{ productId: chai.id, quantity: 2, unitPriceAtPurchase: 10.0 }],
  });
  await createOrderRow(storeId, {
    createdAt: "2026-08-05T00:00:01.000Z",
    status: "PAID",
    total: 10.0,
    soldByStaffId: ben.staff.id,
    lines: [{ productId: muffin.id, quantity: 2, unitPriceAtPurchase: 5.0 }],
  });
  // Not successful — excluded by status.
  await createOrderRow(storeId, {
    createdAt: "2026-08-06T00:00:00.000Z",
    status: "PENDING",
    total: 999.0,
    lines: [{ productId: chai.id, quantity: 1, unitPriceAtPurchase: 999.0 }],
  });
  await createOrderRow(storeId, {
    createdAt: "2026-08-06T00:00:00.000Z",
    status: "REFUNDED",
    total: 999.0,
    lines: [{ productId: chai.id, quantity: 1, unitPriceAtPurchase: 999.0 }],
  });
  // Exactly at range end — must be excluded (end is exclusive).
  await createOrderRow(storeId, {
    createdAt: "2026-08-07T00:00:00.000Z",
    status: "PAID",
    total: 5.0,
    lines: [{ productId: muffin.id, quantity: 1, unitPriceAtPurchase: 5.0 }],
  });
  // Crosses a UTC midnight: 23:45 on Aug 5 vs 00:15 on Aug 6.
  await createOrderRow(storeId, {
    createdAt: "2026-08-05T23:45:00.000Z",
    status: "PAID",
    total: 10.0,
    lines: [{ productId: chai.id, quantity: 1, unitPriceAtPurchase: 10.0 }],
  });
  await createOrderRow(storeId, {
    createdAt: "2026-08-06T00:15:00.000Z",
    status: "PAID",
    total: 13.5,
    lines: [
      { productId: muffin.id, quantity: 2, unitPriceAtPurchase: 5.0 },
      { productId: bagel.id, quantity: 1, unitPriceAtPurchase: 3.5 },
    ],
  });
  // Previous-period order for the trends comparison: the equally sized
  // preceding window for [Aug 3, Aug 7) is [Jul 30, Aug 3).
  await createOrderRow(storeId, {
    createdAt: "2026-07-31T12:00:00.000Z",
    status: "PAID",
    total: 20.0,
    lines: [{ productId: chai.id, quantity: 2, unitPriceAtPurchase: 10.0 }],
  });
  // Staff inventory activity within range.
  await createLedgerRow(storeId, {
    staffId: ada.staff.id,
    productId: chai.id,
    quantityChange: 10,
    reason: "RESTOCK",
  });
  await createLedgerRow(storeId, {
    staffId: ada.staff.id,
    productId: muffin.id,
    quantityChange: 5,
    reason: "RESTOCK",
  });
  await createLedgerRow(storeId, {
    staffId: cara.staff.id,
    productId: bagel.id,
    quantityChange: -3,
    reason: "MANUAL_ADJUSTMENT",
  });

  return { chai, muffin, bagel, ada, ben, cara };
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

afterEach(() => {
  // no global stubs to clear
});

describe("GET /api/dashboard/analytics/summary (integration)", () => {
  it("returns exact totals for the seeded dataset (deliverable fixture)", async () => {
    const { store, token } = await createTenantWithOwner();
    await seedStoreA(store.id);

    const res = await request(app)
      .get("/api/dashboard/analytics/summary")
      .query({ date: SELECTED_DATE })
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      date: SELECTED_DATE,
      totalSales: "35.50",
      orderCount: 3,
      bestSellers: [
        { productId: expect.any(String), name: "Chai", units: 2, revenue: "20.00" },
        { productId: expect.any(String), name: "Bagel", units: 3, revenue: "10.50" },
        { productId: expect.any(String), name: "Muffin", units: 1, revenue: "5.00" },
      ],
    });
  });

  it("supports the top parameter", async () => {
    const { store, token } = await createTenantWithOwner();
    await seedStoreA(store.id);

    const res = await request(app)
      .get("/api/dashboard/analytics/summary")
      .query({ date: SELECTED_DATE, top: 2 })
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.bestSellers).toHaveLength(2);
    expect(res.body.bestSellers.map((b: { name: string }) => b.name)).toEqual(["Chai", "Muffin"]);
  });

  it("returns zeros for a date with no orders", async () => {
    const { store, token } = await createTenantWithOwner();
    await seedStoreA(store.id);

    const res = await request(app)
      .get("/api/dashboard/analytics/summary")
      .query({ date: "2026-08-10" })
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ totalSales: "0.00", orderCount: 0, bestSellers: [] });
  });

  it("is available to a store with no subscription (basic tier)", async () => {
    const { store, token } = await createTenantWithOwner();
    await seedStoreA(store.id);

    const res = await request(app)
      .get("/api/dashboard/analytics/summary")
      .query({ date: SELECTED_DATE })
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.orderCount).toBe(3);
  });

  it("does not leak another tenant's orders (cross-tenant isolation)", async () => {
    const { store: storeA, token: tokenA } = await createTenantWithOwner();
    await seedStoreA(storeA.id);
    const { store: storeB, token: tokenB } = await createTenantWithOwner();
    const pb = await createProductRow(storeB.id, "Sneaky Product", 9999.0);
    await createOrderRow(storeB.id, {
      createdAt: "2026-08-03T12:00:00.000Z",
      status: "PAID",
      total: 9999.0,
      lines: [{ productId: pb.id, quantity: 1, unitPriceAtPurchase: 9999.0 }],
    });

    const resA = await request(app)
      .get("/api/dashboard/analytics/summary")
      .query({ date: SELECTED_DATE })
      .set("Authorization", `Bearer ${tokenA}`);
    expect(resA.status).toBe(200);
    expect(resA.body).toMatchObject({ totalSales: "35.50", orderCount: 3 });
    expect(resA.body.bestSellers.map((b: { name: string }) => b.name)).not.toContain(
      "Sneaky Product",
    );

    const resB = await request(app)
      .get("/api/dashboard/analytics/summary")
      .query({ date: SELECTED_DATE })
      .set("Authorization", `Bearer ${tokenB}`);
    expect(resB.status).toBe(200);
    expect(resB.body).toMatchObject({ totalSales: "9999.00", orderCount: 1 });
  });

  it("rejects staff without the analytics.manage permission (403)", async () => {
    const { store, token } = await createTenantWithOwner();
    await seedStoreA(store.id);
    const staff = await createStaffMember(store.id, { firstName: "No", lastName: "Access" });
    const staffToken = signAccessToken({ sub: staff.account.id, storeId: store.id, role: "STAFF" });

    const res = await request(app)
      .get("/api/dashboard/analytics/summary")
      .query({ date: SELECTED_DATE })
      .set("Authorization", `Bearer ${staffToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCESS_DENIED");
    void token;
  });

  it("allows staff with the analytics.manage permission", async () => {
    const { store } = await createTenantWithOwner();
    await seedStoreA(store.id);
    const staff = await createStaffMember(store.id, {
      firstName: "Granted",
      lastName: "Access",
      permissions: ["analytics.manage"],
    });
    const staffToken = signAccessToken({ sub: staff.account.id, storeId: store.id, role: "STAFF" });

    const res = await request(app)
      .get("/api/dashboard/analytics/summary")
      .query({ date: SELECTED_DATE })
      .set("Authorization", `Bearer ${staffToken}`);

    expect(res.status).toBe(200);
  });
});

describe("GET /api/dashboard/analytics/timeseries (integration)", () => {
  it("returns zero-filled daily buckets with exact totals", async () => {
    const { store, token } = await createTenantWithOwner();
    await seedStoreA(store.id);

    const res = await request(app)
      .get("/api/dashboard/analytics/timeseries")
      .query({ date: SELECTED_DATE })
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.buckets).toEqual([{ date: SELECTED_DATE, totalSales: "35.50", orderCount: 3 }]);
  });

  it("returns only the selected UTC calendar day at a midnight boundary", async () => {
    const { store, token } = await createTenantWithOwner();
    await seedStoreA(store.id);

    const res = await request(app)
      .get("/api/dashboard/analytics/timeseries")
      .query({ date: "2026-08-05" })
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.buckets).toEqual([{ date: "2026-08-05", totalSales: "30.00", orderCount: 2 }]);
  });

  it("rejects weekly buckets because analytics is date-based", async () => {
    const { store, token } = await createTenantWithOwner();
    await seedStoreA(store.id);

    const res = await request(app)
      .get("/api/dashboard/analytics/timeseries")
      .query({ date: SELECTED_DATE, granularity: "weekly" })
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
  });
});

describe("GET /api/dashboard/analytics/trends (advanced, integration)", () => {
  it("returns totals, previous-period comparison, and changePercent", async () => {
    const { store, token } = await createTenantWithOwner();
    await seedStoreA(store.id);
    await attachSubscription(store.id, { tier: "PRO" });

    const res = await request(app)
      .get("/api/dashboard/analytics/trends")
      .query({ date: SELECTED_DATE })
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({ totalSales: "35.50", orderCount: 3 });
    expect(res.body.previousPeriod).toEqual({
      date: "2026-08-02",
      totalSales: "0.00",
      orderCount: 0,
    });
    expect(res.body.changePercent).toBeNull();
  });

  it("returns null changePercent when the previous period had no sales", async () => {
    const { store, token } = await createTenantWithOwner();
    await seedStoreA(store.id);
    await attachSubscription(store.id, { tier: "PRO" });

    const res = await request(app)
      .get("/api/dashboard/analytics/trends")
      .query({ date: "2026-08-10" })
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({ totalSales: "0.00", orderCount: 0 });
    expect(res.body.previousPeriod.totalSales).toBe("0.00");
    expect(res.body.changePercent).toBeNull();
  });

  it("rejects STARTER tier with ADVANCED_ANALYTICS_REQUIRED", async () => {
    const { store, token } = await createTenantWithOwner();
    await seedStoreA(store.id);
    await attachSubscription(store.id, { tier: "STARTER" });

    const res = await request(app)
      .get("/api/dashboard/analytics/trends")
      .query({ date: "2026-08-04" })
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ADVANCED_ANALYTICS_REQUIRED");
  });

  it("rejects a store with no subscription with SUBSCRIPTION_INACTIVE", async () => {
    const { store, token } = await createTenantWithOwner();
    await seedStoreA(store.id);

    const res = await request(app)
      .get("/api/dashboard/analytics/trends")
      .query({ date: SELECTED_DATE })
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("SUBSCRIPTION_INACTIVE");
  });
});

describe("GET /api/dashboard/analytics/staff-performance (advanced, integration)", () => {
  it("merges sales attribution and inventory activity with exact figures", async () => {
    const { store, token } = await createTenantWithOwner();
    await seedStoreA(store.id);
    await attachSubscription(store.id, { tier: "PRO" });

    const res = await request(app)
      .get("/api/dashboard/analytics/staff-performance")
      .query({ date: "2026-08-04" })
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.staff).toEqual([
      {
        staffMemberId: expect.any(String),
        name: "Ben Yusuf",
        sales: { orderCount: 1, revenue: "10.00" },
        inventoryActivity: { entries: 0, unitsAdjusted: 0 },
      },
      {
        staffMemberId: expect.any(String),
        name: "Ada Obi",
        sales: { orderCount: 0, revenue: "0.00" },
        inventoryActivity: { entries: 2, unitsAdjusted: 15 },
      },
      {
        staffMemberId: expect.any(String),
        name: "Cara Li",
        sales: { orderCount: 0, revenue: "0.00" },
        inventoryActivity: { entries: 1, unitsAdjusted: -3 },
      },
    ]);
  });

  it("rejects STARTER tier", async () => {
    const { store, token } = await createTenantWithOwner();
    await seedStoreA(store.id);
    await attachSubscription(store.id, { tier: "STARTER" });

    const res = await request(app)
      .get("/api/dashboard/analytics/staff-performance")
      .query({ date: SELECTED_DATE })
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ADVANCED_ANALYTICS_REQUIRED");
  });
});

describe("date validation (shared by all analytics endpoints)", () => {
  it("requires one valid calendar date", async () => {
    const { token } = await createTenantWithOwner();

    const missing = await request(app)
      .get("/api/dashboard/analytics/summary")
      .set("Authorization", `Bearer ${token}`);
    expect(missing.status).toBe(400);

    const invalid = await request(app)
      .get("/api/dashboard/analytics/summary")
      .query({ date: "2026-02-30" })
      .set("Authorization", `Bearer ${token}`);
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("INVALID_RANGE");
  });

  it("rejects an unknown granularity", async () => {
    const { token } = await createTenantWithOwner();

    const res = await request(app)
      .get("/api/dashboard/analytics/timeseries")
      .query({ date: SELECTED_DATE, granularity: "hourly" })
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_RANGE");
  });
});

describe("GET /api/dashboard/analytics/channels (advanced, integration)", () => {
  it("groups successful sales by source and zero-fills every channel", async () => {
    const { store, token } = await createTenantWithOwner();
    const product = await createProductRow(store.id, "Chai", 100);
    await createOrderRow(store.id, {
      createdAt: RANGE_START,
      status: "PAID",
      total: 100,
      source: "POS",
      lines: [{ productId: product.id, quantity: 1, unitPriceAtPurchase: 100 }],
    });
    await createOrderRow(store.id, {
      createdAt: RANGE_START,
      status: "PAID",
      total: 50,
      source: "POS",
      lines: [{ productId: product.id, quantity: 1, unitPriceAtPurchase: 50 }],
    });
    await createOrderRow(store.id, {
      createdAt: RANGE_START,
      status: "PAID",
      total: 30,
      source: "STOREFRONT",
      lines: [{ productId: product.id, quantity: 1, unitPriceAtPurchase: 30 }],
    });
    await createOrderRow(store.id, {
      createdAt: RANGE_START,
      status: "PAID",
      total: 20,
      source: "SOCIAL",
      lines: [{ productId: product.id, quantity: 1, unitPriceAtPurchase: 20 }],
    });
    await attachSubscription(store.id, { tier: "PRO" });

    const res = await request(app)
      .get("/api/dashboard/analytics/channels")
      .query({ date: SELECTED_DATE })
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.channels).toEqual([
      { source: "POS", orderCount: 2, revenue: "150.00" },
      { source: "STOREFRONT", orderCount: 1, revenue: "30.00" },
      { source: "DIRECT", orderCount: 0, revenue: "0.00" },
      { source: "SOCIAL", orderCount: 1, revenue: "20.00" },
      { source: "MARKETPLACE", orderCount: 0, revenue: "0.00" },
      { source: "REFERRAL", orderCount: 0, revenue: "0.00" },
    ]);
  });

  it("rejects STARTER tier with ADVANCED_ANALYTICS_REQUIRED", async () => {
    const { store, token } = await createTenantWithOwner();
    await attachSubscription(store.id, { tier: "STARTER" });

    const res = await request(app)
      .get("/api/dashboard/analytics/channels")
      .query({ date: SELECTED_DATE })
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ADVANCED_ANALYTICS_REQUIRED");
  });
});
