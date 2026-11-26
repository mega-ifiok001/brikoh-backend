import { describe, expect, it, vi } from "vitest";
import { Prisma } from "../../../generated/prisma/client.js";
import { ReportsService } from "./service.js";

type Mock = ReturnType<typeof vi.fn>;

interface ReportsDbStub {
  order: { aggregate: Mock };
  orderLineItem: { findMany: Mock };
  expense: { aggregate: Mock; groupBy: Mock };
}

const STORE_ID = "c0000000-0000-4000-8000-000000000001";
const D = (v: string | number) => new Prisma.Decimal(v);

const START = new Date("2026-08-01T00:00:00.000Z");
const END = new Date("2026-09-01T00:00:00.000Z");

function createDbStub(): ReportsDbStub {
  return {
    order: { aggregate: vi.fn() },
    orderLineItem: { findMany: vi.fn() },
    expense: { aggregate: vi.fn(), groupBy: vi.fn() },
  };
}

describe("ReportsService.getPnl", () => {
  it("computes revenue - cogs - expenses, counts unpriced line items, and echoes the range", async () => {
    const db = createDbStub();
    db.order.aggregate.mockResolvedValue({ _sum: { total: D("1250000.00") } });
    db.orderLineItem.findMany.mockResolvedValue([
      { quantity: 10, product: { costPrice: D("100.00") } },
      { quantity: 5, product: { costPrice: null } },
    ]);
    db.expense.aggregate.mockResolvedValue({ _sum: { amount: D("125000.00") } });

    const service = new ReportsService(db as never);
    const pnl = await service.getPnl(STORE_ID, START, END);

    expect(pnl).toEqual({
      range: {
        start: "2026-08-01T00:00:00.000Z",
        end: "2026-09-01T00:00:00.000Z",
      },
      revenue: "1250000.00",
      cogs: "1000.00",
      expenses: "125000.00",
      netProfit: "1124000.00",
      cogsUnpricedLineItems: 1,
    });
  });

  it("filters orders/line items/expenses by the supplied half-open range", async () => {
    const db = createDbStub();
    db.order.aggregate.mockResolvedValue({ _sum: { total: D("0") } });
    db.orderLineItem.findMany.mockResolvedValue([]);
    db.expense.aggregate.mockResolvedValue({ _sum: { amount: D("0") } });

    const service = new ReportsService(db as never);
    await service.getPnl(STORE_ID, START, END);

    const orderArg = db.order.aggregate.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(orderArg.where.storeId).toBe(STORE_ID);
    expect(orderArg.where.status).toEqual({ in: ["PAID", "SHIPPED"] });
    expect(orderArg.where.createdAt).toEqual({ gte: START, lt: END });

    const lineArg = db.orderLineItem.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    expect(lineArg.where.order).toEqual({
      status: { in: ["PAID", "SHIPPED"] },
      createdAt: { gte: START, lt: END },
    });

    const expenseArg = db.expense.aggregate.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(expenseArg.where.date).toEqual({ gte: START, lt: END });
  });

  it("zeroes everything for an empty range", async () => {
    const db = createDbStub();
    db.order.aggregate.mockResolvedValue({ _sum: { total: null } });
    db.orderLineItem.findMany.mockResolvedValue([]);
    db.expense.aggregate.mockResolvedValue({ _sum: { amount: null } });

    const service = new ReportsService(db as never);
    const pnl = await service.getPnl(STORE_ID, START, END);

    expect(pnl.revenue).toBe("0.00");
    expect(pnl.cogs).toBe("0.00");
    expect(pnl.expenses).toBe("0.00");
    expect(pnl.netProfit).toBe("0.00");
    expect(pnl.cogsUnpricedLineItems).toBe(0);
  });
});

describe("ReportsService.getExpensesByCategory", () => {
  it("groups by category, totals with 2 dp, sorts by total descending, echoes the date", async () => {
    const db = createDbStub();
    db.expense.groupBy.mockResolvedValue([
      { category: "PACKAGING", _count: { _all: 4 }, _sum: { amount: D("12500.00") } },
      { category: "RENT", _count: { _all: 1 }, _sum: { amount: D("450000.00") } },
    ]);

    const service = new ReportsService(db as never);
    const view = await service.getExpensesByCategory(STORE_ID, START, END);

    expect(view.categories).toEqual([
      { category: "RENT", count: 1, total: "450000.00" },
      { category: "PACKAGING", count: 4, total: "12500.00" },
    ]);
    expect(view.grandTotal).toBe("462500.00");
    expect(view.date).toBe("2026-08-01");
  });

  it("returns an empty category list for no expenses", async () => {
    const db = createDbStub();
    db.expense.groupBy.mockResolvedValue([]);

    const service = new ReportsService(db as never);
    const view = await service.getExpensesByCategory(STORE_ID, START, END);

    expect(view.categories).toEqual([]);
    expect(view.grandTotal).toBe("0.00");
  });
});

describe("ReportsService CSV rows", () => {
  it("serializes the P&L to one CSV row (no period key column)", async () => {
    const db = createDbStub();
    db.order.aggregate.mockResolvedValue({ _sum: { total: D("1250000.00") } });
    db.orderLineItem.findMany.mockResolvedValue([
      { quantity: 10, product: { costPrice: D("100.00") } },
      { quantity: 5, product: { costPrice: null } },
    ]);
    db.expense.aggregate.mockResolvedValue({ _sum: { amount: D("125000.00") } });

    const service = new ReportsService(db as never);
    const rows = await service.pnlCsvRows(STORE_ID, START, END);

    expect(rows).toEqual([
      {
        start: "2026-08-01T00:00:00.000Z",
        end: "2026-09-01T00:00:00.000Z",
        revenue: "1250000.00",
        cogs: "1000.00",
        expenses: "125000.00",
        netProfit: "1124000.00",
        cogsUnpricedLineItems: "1",
      },
    ]);
  });

  it("serializes categories to one row each", async () => {
    const db = createDbStub();
    db.expense.groupBy.mockResolvedValue([
      { category: "RENT", _count: { _all: 1 }, _sum: { amount: D("450000.00") } },
    ]);

    const service = new ReportsService(db as never);
    const rows = await service.categoryCsvRows(STORE_ID, START, END);

    expect(rows).toEqual([{ category: "RENT", count: "1", total: "450000.00" }]);
  });
});
