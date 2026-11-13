import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "../../../generated/prisma/client.js";
import { AnalyticsService, type AnalyticsDb } from "./service.js";

const D = (v: string) => new Prisma.Decimal(v);

const STORE_ID = "00000000-0000-0000-0000-000000000001";
const RANGE = {
  start: new Date("2026-08-03T00:00:00.000Z"),
  end: new Date("2026-08-07T00:00:00.000Z"),
};

function subscriptionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    storeId: STORE_ID,
    tier: "PRO",
    status: "ACTIVE",
    staffCap: null,
    locationCap: null,
    productCap: null,
    orderCap: null,
    ...overrides,
  };
}

function createDb() {
  return {
    store: { findUnique: vi.fn() },
    subscription: { findUnique: vi.fn() },
    order: {
      aggregate: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn(),
      groupBy: vi.fn(),
    },
    orderLineItem: { findMany: vi.fn() },
    stockLedgerEntry: { groupBy: vi.fn() },
    staffMember: { findMany: vi.fn() },
  };
}

type MockDb = ReturnType<typeof createDb>;

function attachSubscription(db: MockDb, overrides: Record<string, unknown> = {}) {
  db.store.findUnique.mockResolvedValue({ id: STORE_ID, subscriptionId: "sub-1" });
  db.subscription.findUnique.mockResolvedValue(subscriptionRow(overrides));
}

const LINE_ITEMS = [
  { productId: "p1", quantity: 2, unitPriceAtPurchase: D("10.00"), product: { name: "Chai" } },
  { productId: "p2", quantity: 1, unitPriceAtPurchase: D("5.00"), product: { name: "Muffin" } },
  { productId: "p3", quantity: 2, unitPriceAtPurchase: D("3.50"), product: { name: "Bagel" } },
  { productId: "p3", quantity: 1, unitPriceAtPurchase: D("3.50"), product: { name: "Bagel" } },
  { productId: "p1", quantity: 2, unitPriceAtPurchase: D("10.00"), product: { name: "Chai" } },
  { productId: "p2", quantity: 2, unitPriceAtPurchase: D("5.00"), product: { name: "Muffin" } },
];

const ORDERS_IN_RANGE = [
  { createdAt: new Date("2026-08-03T09:30:00.000Z"), total: D("25.00") },
  { createdAt: new Date("2026-08-03T23:59:59.000Z"), total: D("7.00") },
  { createdAt: new Date("2026-08-03T00:00:00.000Z"), total: D("3.50") },
  { createdAt: new Date("2026-08-05T00:00:00.000Z"), total: D("20.00") },
  { createdAt: new Date("2026-08-05T00:00:01.000Z"), total: D("10.00") },
];

describe("AnalyticsService.getSalesSummary", () => {
  let db: MockDb;
  let service: AnalyticsService;

  beforeEach(() => {
    db = createDb();
    service = new AnalyticsService(db as unknown as AnalyticsDb);
  });

  it("returns exact totals, order count, and ranked best sellers", async () => {
    db.order.aggregate.mockResolvedValue({ _sum: { total: D("65.50") } } as never);
    db.order.count.mockResolvedValue(5);
    db.orderLineItem.findMany.mockResolvedValue(LINE_ITEMS as never);

    const result = await service.getSalesSummary(STORE_ID, RANGE);

    expect(result).toEqual({
      range: {
        start: "2026-08-03T00:00:00.000Z",
        end: "2026-08-07T00:00:00.000Z",
      },
      totalSales: "65.50",
      orderCount: 5,
      bestSellers: [
        { productId: "p1", name: "Chai", units: 4, revenue: "40.00" },
        { productId: "p2", name: "Muffin", units: 3, revenue: "15.00" },
        { productId: "p3", name: "Bagel", units: 3, revenue: "10.50" },
      ],
    });
  });

  it("respects the top parameter", async () => {
    db.order.aggregate.mockResolvedValue({ _sum: { total: D("65.50") } } as never);
    db.order.count.mockResolvedValue(5);
    db.orderLineItem.findMany.mockResolvedValue(LINE_ITEMS as never);

    const result = await service.getSalesSummary(STORE_ID, RANGE, 2);
    expect(result.bestSellers.map((b) => b.name)).toEqual(["Chai", "Muffin"]);
  });

  it("scopes every query to the tenant's store and the range", async () => {
    db.order.aggregate.mockResolvedValue({ _sum: { total: D("0.00") } } as never);
    db.order.count.mockResolvedValue(0);
    db.orderLineItem.findMany.mockResolvedValue([] as never);

    await service.getSalesSummary(STORE_ID, RANGE);

    expect(db.order.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          storeId: STORE_ID,
          status: { in: ["PAID", "SHIPPED"] },
          createdAt: { gte: RANGE.start, lt: RANGE.end },
        },
      }),
    );
    expect(db.order.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ storeId: STORE_ID }) }),
    );
    expect(db.orderLineItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ storeId: STORE_ID }),
      }),
    );
  });

  it("returns zeros and an empty list for a range with no orders", async () => {
    db.order.aggregate.mockResolvedValue({ _sum: { total: null } } as never);
    db.order.count.mockResolvedValue(0);
    db.orderLineItem.findMany.mockResolvedValue([] as never);

    const result = await service.getSalesSummary(STORE_ID, RANGE);
    expect(result).toMatchObject({ totalSales: "0.00", orderCount: 0, bestSellers: [] });
  });
});

describe("AnalyticsService.getTimeseries", () => {
  let db: MockDb;
  let service: AnalyticsService;

  beforeEach(() => {
    db = createDb();
    service = new AnalyticsService(db as unknown as AnalyticsDb);
  });

  it("returns zero-filled daily buckets with exact totals (basic tier, no gate)", async () => {
    db.order.findMany.mockResolvedValue(ORDERS_IN_RANGE as never);

    const result = await service.getTimeseries(STORE_ID, RANGE, "daily");
    expect(result.granularity).toBe("daily");
    expect(result.buckets).toEqual([
      {
        start: "2026-08-03T00:00:00.000Z",
        end: "2026-08-04T00:00:00.000Z",
        totalSales: "35.50",
        orderCount: 3,
      },
      {
        start: "2026-08-04T00:00:00.000Z",
        end: "2026-08-05T00:00:00.000Z",
        totalSales: "0.00",
        orderCount: 0,
      },
      {
        start: "2026-08-05T00:00:00.000Z",
        end: "2026-08-06T00:00:00.000Z",
        totalSales: "30.00",
        orderCount: 2,
      },
      {
        start: "2026-08-06T00:00:00.000Z",
        end: "2026-08-07T00:00:00.000Z",
        totalSales: "0.00",
        orderCount: 0,
      },
    ]);
  });

  it("returns a single Monday-aligned weekly bucket", async () => {
    db.order.findMany.mockResolvedValue(ORDERS_IN_RANGE as never);

    const result = await service.getTimeseries(STORE_ID, RANGE, "weekly");
    expect(result.buckets).toEqual([
      {
        start: "2026-08-03T00:00:00.000Z",
        end: "2026-08-10T00:00:00.000Z",
        totalSales: "65.50",
        orderCount: 5,
      },
    ]);
  });

  it("queries only successful statuses for the tenant's store", async () => {
    db.order.findMany.mockResolvedValue([] as never);
    await service.getTimeseries(STORE_ID, RANGE, "daily");
    expect(db.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          storeId: STORE_ID,
          status: { in: ["PAID", "SHIPPED"] },
          createdAt: { gte: RANGE.start, lt: RANGE.end },
        },
      }),
    );
  });
});

describe("AnalyticsService.getSalesTrends (advanced)", () => {
  let db: MockDb;
  let service: AnalyticsService;

  beforeEach(() => {
    db = createDb();
    service = new AnalyticsService(db as unknown as AnalyticsDb);
  });

  it("returns totals, previous-period comparison, and changePercent", async () => {
    attachSubscription(db, { tier: "PRO" });
    db.order.findMany
      .mockResolvedValueOnce(ORDERS_IN_RANGE as never)
      .mockResolvedValueOnce([
        { createdAt: new Date("2026-07-31T12:00:00.000Z"), total: D("20.00") },
      ] as never);

    const result = await service.getSalesTrends(STORE_ID, RANGE, "daily");

    expect(result.totals).toEqual({ totalSales: "65.50", orderCount: 5 });
    expect(result.previousPeriod).toEqual({
      start: "2026-07-30T00:00:00.000Z",
      end: "2026-08-03T00:00:00.000Z",
      totalSales: "20.00",
      orderCount: 1,
    });
    expect(result.changePercent).toBe(227.5);
    expect(result.buckets).toHaveLength(4);
  });

  it("returns null changePercent when the previous period had no sales", async () => {
    attachSubscription(db, { tier: "PRO" });
    db.order.findMany
      .mockResolvedValueOnce([
        { createdAt: new Date("2026-08-04T10:00:00.000Z"), total: D("10.00") },
      ] as never)
      .mockResolvedValueOnce([] as never);

    const result = await service.getSalesTrends(STORE_ID, RANGE, "daily");
    expect(result.previousPeriod.totalSales).toBe("0.00");
    expect(result.changePercent).toBeNull();
  });

  it.each([
    [
      "no subscription",
      { subscriptionId: null },
      /no active subscription/i,
      "SUBSCRIPTION_INACTIVE",
    ],
    [
      "inactive subscription",
      { status: "CANCELLED" },
      /Your subscription is CANCELLED/i,
      "SUBSCRIPTION_INACTIVE",
    ],
    ["STARTER tier", { tier: "STARTER" }, /upgrade to PRO/i, "ADVANCED_ANALYTICS_REQUIRED"],
  ])("rejects %s with 403 %s", async (_label, subOverrides, messagePattern, code) => {
    if ((subOverrides as { subscriptionId?: unknown }).subscriptionId === null) {
      db.store.findUnique.mockResolvedValue({ id: STORE_ID, subscriptionId: null });
    } else {
      attachSubscription(db, subOverrides);
    }
    db.order.findMany.mockResolvedValue([] as never);

    await expect(service.getSalesTrends(STORE_ID, RANGE, "daily")).rejects.toMatchObject({
      statusCode: 403,
      code,
      message: expect.stringMatching(messagePattern),
    });
  });

  it("allows ENTERPRISE tier", async () => {
    attachSubscription(db, { tier: "ENTERPRISE" });
    db.order.findMany.mockResolvedValue([] as never);
    await expect(service.getSalesTrends(STORE_ID, RANGE, "daily")).resolves.toMatchObject({
      changePercent: null,
    });
  });
});

describe("AnalyticsService.getStaffPerformance (advanced)", () => {
  let db: MockDb;
  let service: AnalyticsService;

  beforeEach(() => {
    db = createDb();
    service = new AnalyticsService(db as unknown as AnalyticsDb);
  });

  it("merges sales attribution and inventory activity per staff member", async () => {
    attachSubscription(db, { tier: "PRO" });
    db.order.groupBy.mockResolvedValue([
      { soldByStaffId: "s1", _count: 2, _sum: { total: D("45.00") } },
      { soldByStaffId: "s2", _count: 1, _sum: { total: D("10.00") } },
    ] as never);
    db.stockLedgerEntry.groupBy.mockResolvedValue([
      { performedByStaffId: "s1", _count: 2, _sum: { quantityChange: 15 } },
      { performedByStaffId: "s3", _count: 1, _sum: { quantityChange: -3 } },
    ] as never);
    db.staffMember.findMany.mockResolvedValue([
      { id: "s1", account: { firstName: "Ada", lastName: "Obi" } },
      { id: "s2", account: { firstName: "Ben", lastName: "Yusuf" } },
      { id: "s3", account: { firstName: "Cara", lastName: "Li" } },
    ] as never);

    const result = await service.getStaffPerformance(STORE_ID, RANGE);

    expect(result.staff).toEqual([
      {
        staffMemberId: "s1",
        name: "Ada Obi",
        sales: { orderCount: 2, revenue: "45.00" },
        inventoryActivity: { entries: 2, unitsAdjusted: 15 },
      },
      {
        staffMemberId: "s2",
        name: "Ben Yusuf",
        sales: { orderCount: 1, revenue: "10.00" },
        inventoryActivity: { entries: 0, unitsAdjusted: 0 },
      },
      {
        staffMemberId: "s3",
        name: "Cara Li",
        sales: { orderCount: 0, revenue: "0.00" },
        inventoryActivity: { entries: 1, unitsAdjusted: -3 },
      },
    ]);
  });

  it("scopes both groupBys to the tenant and range", async () => {
    attachSubscription(db, { tier: "PRO" });
    db.order.groupBy.mockResolvedValue([] as never);
    db.stockLedgerEntry.groupBy.mockResolvedValue([] as never);
    db.staffMember.findMany.mockResolvedValue([] as never);

    await service.getStaffPerformance(STORE_ID, RANGE);

    expect(db.order.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["soldByStaffId"],
        where: expect.objectContaining({
          storeId: STORE_ID,
          soldByStaffId: { not: null },
          createdAt: { gte: RANGE.start, lt: RANGE.end },
        }),
      }),
    );
    expect(db.stockLedgerEntry.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["performedByStaffId"],
        where: expect.objectContaining({ storeId: STORE_ID }),
      }),
    );
  });

  it("gates advanced access like trends", async () => {
    attachSubscription(db, { tier: "STARTER" });
    await expect(service.getStaffPerformance(STORE_ID, RANGE)).rejects.toMatchObject({
      statusCode: 403,
      code: "ADVANCED_ANALYTICS_REQUIRED",
    });
  });
});
