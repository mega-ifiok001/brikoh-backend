import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient } from "../../../generated/prisma/client.js";

const prismaMocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({
  getPrismaClient: prismaMocks.getPrismaClient,
}));

const ordersMocks = vi.hoisted(() => ({ listOrders: vi.fn() }));
vi.mock("../orders/service.js", () => ({
  listOrders: ordersMocks.listOrders,
}));

import { getOverview } from "./service.js";

type Mock = ReturnType<typeof vi.fn>;

interface PrismaStub {
  order: { aggregate: Mock; findMany: Mock; count: Mock; fields: { total: unknown } };
  orderLineItem: { findMany: Mock };
  customer: { count: Mock };
  product: { findMany: Mock; count: Mock };
  branch: { count: Mock };
  branchStock: { findMany: Mock };
}

function createPrismaStub(): PrismaStub {
  return {
    order: {
      aggregate: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      // Mirror of what Prisma exposes on the client for field references.
      fields: { total: "total" },
    },
    orderLineItem: { findMany: vi.fn() },
    customer: { count: vi.fn() },
    product: { findMany: vi.fn(), count: vi.fn() },
    branch: { count: vi.fn() },
    branchStock: { findMany: vi.fn() },
  };
}

const D = (v: string) => new Prisma.Decimal(v);
const STORE_ID = "store-1";

let stub: PrismaStub;

beforeEach(() => {
  stub = createPrismaStub();
  prismaMocks.getPrismaClient.mockReturnValue(stub as unknown as PrismaClient);
  ordersMocks.listOrders.mockReset();

  stub.order.aggregate.mockResolvedValue({ _sum: { total: D("1250.50") } });
  stub.customer.count.mockResolvedValue(12);
  stub.order.findMany.mockImplementation((args: { where?: { paymentMethod?: string } }) =>
    Promise.resolve(
      args.where?.paymentMethod === "CREDIT"
        ? []
        : [{ createdAt: new Date("2026-08-12T10:00:00.000Z"), total: D("1250.50") }],
    ),
  );
  stub.orderLineItem.findMany.mockResolvedValue([
    {
      productId: "p-1",
      quantity: 7,
      unitPriceAtPurchase: D("100"),
      product: { name: "Bottled Water" },
    },
  ]);
  stub.order.count.mockResolvedValue(2);
  stub.product.count.mockResolvedValue(14);
  stub.branch.count.mockResolvedValue(1);
  stub.branchStock.findMany.mockResolvedValue([]);
  stub.product.findMany.mockResolvedValue([]);

  ordersMocks.listOrders.mockResolvedValue({
    items: [
      {
        id: "o-1",
        status: "PAID",
        paymentMethod: "CASH",
        source: "POS",
        total: "1250.00",
        customer: { name: "Ade Okafor" },
        itemCount: 2,
        createdAt: new Date("2026-08-12T10:00:00.000Z"),
      },
    ],
    nextCursor: null,
  });
});

describe("getOverview (unit)", () => {
  it("returns kpis, trend, top products, and quickStats for revenue-visible callers", async () => {
    const result = await getOverview(STORE_ID, true);

    expect(result.kpis).toEqual({
      revenue: "1250.50",
      orders: 1,
      customers: 12,
      avgOrderValue: "1250.50",
    });
    // Daily buckets for the whole window (31 UTC-day spans from a
    // midday start), newest first — the newest bucket starts at
    // today's UTC midnight.
    expect(result.revenueTrend).toHaveLength(31);
    expect(result.revenueTrend?.[0]?.start).toBe(
      new Date(
        Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()),
      ).toISOString(),
    );
    expect(result.topProducts).toEqual([
      { productId: "p-1", name: "Bottled Water", units: 7, revenue: "700.00" },
    ]);
    expect(result.recentOrders[0]).toMatchObject({
      id: "o-1",
      customerName: "Ade Okafor",
      lineItemCount: 2,
    });
    expect(result.quickStats).toEqual({
      productCount: 14,
      branchCount: 1,
      pendingOrderCount: 2,
      creditOwing: "0.00",
    });
  });

  it("omits revenue-bearing fields when the caller cannot view profit", async () => {
    const result = await getOverview(STORE_ID, false);

    expect(result.kpis).toEqual({ orders: 1, customers: 12 });
    expect(result.revenueTrend).toBeUndefined();
    expect(result.topProducts[0]).toEqual({
      productId: "p-1",
      name: "Bottled Water",
      units: 7,
    });
  });

  it("computes creditOwing as the sum of unpaid credit balances", async () => {
    stub.order.findMany.mockImplementation((args: { where?: { paymentMethod?: string } }) =>
      Promise.resolve(
        args.where?.paymentMethod === "CREDIT"
          ? [
              { total: D("5000.00"), amountPaid: D("1500.00") },
              { total: D("100.00"), amountPaid: D("100.00") },
            ]
          : [{ createdAt: new Date("2026-08-12T10:00:00.000Z"), total: D("1250.50") }],
      ),
    );

    const result = await getOverview(STORE_ID, true);

    expect(result.quickStats.creditOwing).toBe("3500.00");
  });

  it("reports zeroed kpis when nothing sold in the window", async () => {
    stub.order.aggregate.mockResolvedValue({ _sum: { total: null } });
    stub.order.findMany.mockResolvedValue([]);
    stub.orderLineItem.findMany.mockResolvedValue([]);

    const result = await getOverview(STORE_ID, true);

    expect(result.kpis).toEqual({
      revenue: "0.00",
      orders: 0,
      customers: 12,
      avgOrderValue: "0.00",
    });
    expect(result.revenueTrend?.reduce((sum, b) => sum + b.orderCount, 0)).toBe(0);
  });

  it("lists low-stock rows across branches, quantity ascending", async () => {
    stub.branchStock.findMany.mockResolvedValue([
      {
        quantity: 0,
        branchId: "b-1",
        branch: { name: "Main Branch" },
        product: { id: "p-low", name: "Empty Item", lowStockThreshold: null },
      },
      {
        quantity: 3,
        branchId: "b-2",
        branch: { name: "Branch 2" },
        product: { id: "p-thresh", name: "Near End", lowStockThreshold: 5 },
      },
    ]);

    const result = await getOverview(STORE_ID, true);

    expect(result.lowStock).toEqual([
      {
        productId: "p-low",
        name: "Empty Item",
        branchId: "b-1",
        branchName: "Main Branch",
        quantity: 0,
      },
      {
        productId: "p-thresh",
        name: "Near End",
        branchId: "b-2",
        branchName: "Branch 2",
        quantity: 3,
      },
    ]);
  });

  it("lists expiring products in the next 7 days, no variants", async () => {
    stub.product.findMany.mockResolvedValue([
      {
        id: "p-exp",
        name: "Fresh Milk",
        expiryDate: new Date("2026-08-16T00:00:00.000Z"),
        quantity: 6,
      },
    ]);

    const result = await getOverview(STORE_ID, true);

    expect(result.expiringSoon).toEqual([
      {
        productId: "p-exp",
        name: "Fresh Milk",
        variantId: null,
        expiryDate: new Date("2026-08-16T00:00:00.000Z"),
        quantity: 6,
      },
    ]);
  });
});
