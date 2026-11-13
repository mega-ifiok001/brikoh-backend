import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../../../app.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { signAccessToken } from "../../lib/tokens.js";
import { startOfUtcWeek } from "../analytics/utils.js";

const prisma = createPrismaClient(process.env.TEST_DATABASE_URL);

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

async function createStaffMember(
  storeId: string,
  options: { role: "ADMIN" | "MANAGER" | "STAFF"; permissions: string[] },
) {
  const email = `staff-${crypto.randomUUID()}@example.com`;
  const account = await prisma.account.create({
    data: { email, passwordHash: bcrypt.hashSync("password-123", 4) },
  });
  const staff = await prisma.staffMember.create({
    data: { accountId: account.id, storeId, role: options.role, permissions: options.permissions },
  });
  const token = signAccessToken({
    sub: account.id,
    storeId,
    role: options.role,
    staffMemberId: staff.id,
  });
  return { staff, account, token };
}

const DAY_MS = 86_400_000;

// A fixed mid-month anchor so the range boundaries are deterministic.
const ANCHOR = new Date("2026-08-18T14:30:00.000Z");
const WEEK_START = startOfUtcWeek(ANCHOR); // 2026-08-17T00:00:00.000Z
const WEEK_END = new Date(WEEK_START.getTime() + 7 * DAY_MS); // 2026-08-24T00:00:00.000Z
const MONTH_START = new Date(Date.UTC(2026, 7, 1)); // 2026-08-01T00:00:00.000Z
const MONTH_END = new Date(Date.UTC(2026, 8, 1)); // 2026-09-01T00:00:00.000Z

async function seedPnlData(storeId: string) {
  // Seed relative to the fixed week so tests never depend on the wall clock.
  const at = (dayOffset: number, hour = 10): Date =>
    new Date(WEEK_START.getTime() + dayOffset * DAY_MS + hour * 3_600_000);

  const priced = await prisma.product.create({
    data: { storeId, name: "Priced good", price: 500, quantity: 100, costPrice: "200.00" },
  });
  const unpriced = await prisma.product.create({
    data: { storeId, name: "Unpriced good", price: 300, quantity: 100, costPrice: null },
  });
  const customer = await prisma.customer.create({
    data: { storeId, name: "Test Customer", email: `cust-${crypto.randomUUID()}@example.com` },
  });
  const { defaultBranchId } = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    select: { defaultBranchId: true },
  });

  async function order(createdAt: Date, status: string, total: number, lines: [string, number][]) {
    return prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          storeId,
          customerId: customer.id,
          branchId: defaultBranchId!,
          orderNumber: `ORD-${crypto.randomUUID().slice(0, 8)}`,
          status: status as never,
          total,
          createdAt,
        },
      });
      if (lines.length > 0) {
        await tx.orderLineItem.createMany({
          data: lines.map(([productId, quantity]) => ({
            storeId,
            orderId: created.id,
            productId,
            quantity,
            unitPriceAtPurchase: 0,
          })),
        });
      }
      return created;
    });
  }

  // In-week sales: 2 × priced (cost 200) + 3 × unpriced (cost null).
  await order(at(1), "PAID", 1900, [
    [priced.id, 2],
    [unpriced.id, 3],
  ]);
  await order(at(2), "SHIPPED", 500, [[priced.id, 1]]);
  // Previous-week sale — outside the week, still inside the month.
  await order(at(-3), "PAID", 5000, [[priced.id, 10]]);
  // Non-sale status in week — must not count.
  await order(at(1), "PENDING", 999, [[priced.id, 1]]);

  await prisma.expense.createMany({
    data: [
      { storeId, category: "RENT", amount: "450000.00", date: at(0) },
      { storeId, category: "PACKAGING", amount: "12500.00", date: at(2) },
      // Previous-week expense — excluded from the week, still in-month.
      { storeId, category: "RENT", amount: "450000.00", date: at(-3) },
    ],
  });
}

function rangeQuery(start: Date, end: Date) {
  return { start: start.toISOString(), end: end.toISOString() };
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
    DELETE FROM "BranchStock"; DELETE FROM "Branch";
    DELETE FROM "StaffMember"; DELETE FROM "InviteToken"; DELETE FROM "Owner";
    DELETE FROM "StoreActivityLog";
    DELETE FROM "Expense";
    DELETE FROM "NotificationDispatch";
    DELETE FROM "Subscription"; DELETE FROM "Store"; DELETE FROM "Account";
    ALTER TABLE "StoreActivityLog" ENABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "PurchaseOrderReceipt" ENABLE TRIGGER purchase_order_receipt_append_only;
    ALTER TABLE "PurchaseOrderPayment" ENABLE TRIGGER purchase_order_payment_append_only;
    ALTER TABLE "WalletEntry" ENABLE TRIGGER wallet_ledger_append_only;
    ALTER TABLE "StockLedgerEntry" ENABLE TRIGGER stock_ledger_append_only;
  `;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dashboard reports (integration)", () => {
  it("returns the P&L for an explicit range with correct revenue, cogs, and expenses", async () => {
    const { store, token } = await createTenantWithOwner();
    await seedPnlData(store.id);

    const res = await request(app)
      .get("/api/dashboard/reports/pnl")
      .set("Authorization", `Bearer ${token}`)
      .query(rangeQuery(WEEK_START, WEEK_END));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      range: {
        start: WEEK_START.toISOString(),
        end: WEEK_END.toISOString(),
      },
      revenue: "2400.00",
      cogs: "600.00",
      expenses: "462500.00",
      netProfit: "-460700.00",
      cogsUnpricedLineItems: 1,
    });
  });

  it("narrows to a partial sub-range (a single day)", async () => {
    const { store, token } = await createTenantWithOwner();
    await seedPnlData(store.id);

    // Only the 2026-08-19 (day offset +2) SHIPPED order falls in this day.
    const dayStart = new Date(WEEK_START.getTime() + 2 * DAY_MS);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    const res = await request(app)
      .get("/api/dashboard/reports/pnl")
      .set("Authorization", `Bearer ${token}`)
      .query(rangeQuery(dayStart, dayEnd));

    expect(res.status).toBe(200);
    expect(res.body.revenue).toBe("500.00");
    expect(res.body.cogs).toBe("200.00");
  });

  it("breaks expenses down by category for the range", async () => {
    const { store, token } = await createTenantWithOwner();
    await seedPnlData(store.id);

    const res = await request(app)
      .get("/api/dashboard/reports/expenses-by-category")
      .set("Authorization", `Bearer ${token}`)
      .query(rangeQuery(WEEK_START, WEEK_END));

    expect(res.status).toBe(200);
    expect(res.body.categories).toEqual([
      { category: "RENT", count: 1, total: "450000.00" },
      { category: "PACKAGING", count: 1, total: "12500.00" },
    ]);
    expect(res.body.grandTotal).toBe("462500.00");
    expect(res.body.range).toEqual({
      start: WEEK_START.toISOString(),
      end: WEEK_END.toISOString(),
    });
  });

  it("exports the P&L as a CSV attachment with a date-based filename", async () => {
    const { store, token } = await createTenantWithOwner();
    await seedPnlData(store.id);

    const res = await request(app)
      .get("/api/dashboard/reports/pnl/export.csv")
      .set("Authorization", `Bearer ${token}`)
      .query(rangeQuery(MONTH_START, MONTH_END));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain("pnl-2026-08-01_2026-09-01.csv");
    const body = res.text;
    expect(body.split("\r\n")[0]).toBe(
      "start,end,revenue,cogs,expenses,netProfit,cogsUnpricedLineItems",
    );
    expect(body).toContain(
      `${MONTH_START.toISOString()},${MONTH_END.toISOString()},7400.00,2600.00,912500.00,-907700.00,1`,
    );
  });

  it("rejects a missing or invalid range with INVALID_RANGE", async () => {
    const { token } = await createTenantWithOwner();

    const missing = await request(app)
      .get("/api/dashboard/reports/pnl")
      .set("Authorization", `Bearer ${token}`);
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("INVALID_RANGE");
    expect(missing.body.error.message).toMatch(/start and end date/i);

    const reversed = await request(app)
      .get("/api/dashboard/reports/pnl")
      .set("Authorization", `Bearer ${token}`)
      .query(rangeQuery(WEEK_END, WEEK_START));
    expect(reversed.status).toBe(400);
    expect(reversed.body.error.code).toBe("INVALID_RANGE");
    expect(reversed.body.error.message).toMatch(/before the end date/i);

    const nonUtc = await request(app)
      .get("/api/dashboard/reports/pnl")
      .set("Authorization", `Bearer ${token}`)
      .query({ start: "2026-08-01T00:00:00+01:00", end: MONTH_END.toISOString() });
    expect(nonUtc.status).toBe(400);
    expect(nonUtc.body.error.code).toBe("INVALID_RANGE");
  });

  it("requires the analytics.manage permission to reach the reports", async () => {
    const { store } = await createTenantWithOwner();
    const staff = await createStaffMember(store.id, { role: "STAFF", permissions: [] });

    const res = await request(app)
      .get("/api/dashboard/reports/pnl")
      .set("Authorization", `Bearer ${staff.token}`)
      .query(rangeQuery(WEEK_START, WEEK_END));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCESS_DENIED");
  });

  it("blocks analytics.manage staff without viewProfit from the P&L", async () => {
    const { store } = await createTenantWithOwner();
    const staff = await createStaffMember(store.id, {
      role: "MANAGER",
      permissions: ["analytics.manage"],
    });

    const pnl = await request(app)
      .get("/api/dashboard/reports/pnl")
      .set("Authorization", `Bearer ${staff.token}`)
      .query(rangeQuery(WEEK_START, WEEK_END));
    expect(pnl.status).toBe(403);
    expect(pnl.body.error.code).toBe("ACCESS_DENIED");

    const csv = await request(app)
      .get("/api/dashboard/reports/pnl/export.csv")
      .set("Authorization", `Bearer ${staff.token}`)
      .query(rangeQuery(WEEK_START, WEEK_END));
    expect(csv.status).toBe(403);
  });

  it("allows analytics.manage + viewProfit staff to read the P&L", async () => {
    const { store } = await createTenantWithOwner();
    const staff = await createStaffMember(store.id, {
      role: "MANAGER",
      permissions: ["analytics.manage", "viewProfit"],
    });

    const res = await request(app)
      .get("/api/dashboard/reports/pnl")
      .set("Authorization", `Bearer ${staff.token}`)
      .query(rangeQuery(WEEK_START, WEEK_END));

    expect(res.status).toBe(200);
    expect(res.body.range.start).toBe(WEEK_START.toISOString());
  });
});

describe("inventory valuation (integration)", () => {
  it("values stock at cost and retail, summing variant stock for variant products", async () => {
    const { store: storeRow, mainBranch, token } = await createTenantWithOwner();
    const storeId = storeRow.id;

    const plain = await prisma.product.create({
      data: {
        storeId,
        name: "Plain mug",
        sku: "MUG-001",
        price: "1500.00",
        costPrice: "450.00",
        quantity: 12,
      },
    });
    await prisma.branchStock.create({
      data: {
        storeId,
        branchId: mainBranch.id,
        productId: plain.id,
        variantId: null,
        quantity: 12,
      },
    });
    const uncosted = await prisma.product.create({
      data: { storeId, name: "Gifted bag", price: "800.00", costPrice: null, quantity: 5 },
    });
    const withVariants = await prisma.product.create({
      data: {
        storeId,
        name: "Shirt",
        price: "3000.00",
        costPrice: "1200.00",
        variants: {
          create: [
            { name: "M", storeId },
            { name: "L", storeId },
          ],
        },
      },
    });
    const variants = await prisma.productVariant.findMany({
      where: { productId: withVariants.id },
    });
    await prisma.branchStock.createMany({
      data: variants.map((variant, index) => ({
        storeId,
        branchId: mainBranch.id,
        productId: withVariants.id,
        variantId: variant.id,
        quantity: index + 1,
      })),
    });

    const res = await request(app)
      .get("/api/dashboard/reports/inventory-valuation")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.generatedAt).toBeTypeOf("string");
    const byName = new Map(res.body.items.map((item: { name: string }) => [item.name, item]));
    expect(byName.get("Plain mug")).toEqual({
      productId: plain.id,
      sku: "MUG-001",
      name: "Plain mug",
      quantity: 12,
      costPrice: "450.00",
      price: "1500.00",
      valueAtCost: "5400.00",
      valueAtRetail: "18000.00",
    });
    // Uncosted: no cost value, still counts at retail.
    expect(byName.get("Gifted bag")).toEqual({
      productId: uncosted.id,
      sku: null,
      name: "Gifted bag",
      quantity: 5,
      costPrice: null,
      price: "800.00",
      valueAtCost: "0.00",
      valueAtRetail: "4000.00",
    });
    // Variant product: quantity = 1 + 2 = 3 (per-variant stock).
    expect(byName.get("Shirt")).toEqual({
      productId: withVariants.id,
      sku: null,
      name: "Shirt",
      quantity: 3,
      costPrice: "1200.00",
      price: "3000.00",
      valueAtCost: "3600.00",
      valueAtRetail: "9000.00",
    });
    expect(res.body.totals).toEqual({ atCost: "9000.00", atRetail: "31000.00" });
    expect(res.body.unpricedProducts).toBe(1);
  });

  it("exports the valuation as a CSV attachment", async () => {
    const { store: storeRow, token } = await createTenantWithOwner();
    const storeId = storeRow.id;
    const product = await prisma.product.create({
      data: {
        storeId,
        name: "Plain mug",
        sku: "MUG-001",
        price: "1500.00",
        costPrice: "450.00",
        quantity: 12,
      },
    });

    const res = await request(app)
      .get("/api/dashboard/reports/inventory-valuation/export.csv")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("attachment");
    const body = res.text;
    expect(body.split("\r\n")[0]).toBe(
      "sku,name,quantity,costPrice,price,valueAtCost,valueAtRetail",
    );
    expect(body).toContain("MUG-001,Plain mug,12,450.00,1500.00,5400.00,18000.00");
    expect(product.id).toBeTypeOf("string");
  });
});
