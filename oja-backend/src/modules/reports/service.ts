import { Prisma, type PrismaClient } from "../../../generated/prisma/client.js";
import { toCsv } from "../../lib/csv.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { SALES_STATUSES } from "../analytics/constants.js";

/**
 * ============================================================
 * REPORTS SERVICE — P&L and expense breakdown
 * ============================================================
 * The store's profit-and-loss statement (dashboard-reports.md).
 *
 * Money definitions (all amounts leave as toFixed(2) strings):
 *   revenue  = Σ order.total for orders in SALES_STATUSES (PAID/SHIPPED)
 *              created inside the range — the same sale definition the
 *              analytics module uses.
 *   cogs     = Σ product.costPrice × lineItem.quantity over those
 *              orders' line items. A product with no recorded
 *              costPrice contributes 0 and is counted in
 *              cogsUnpricedLineItems so the report surfaces the
 *              overstatement instead of hiding it.
 *   expenses = Σ expense.amount for expenses whose date falls inside
 *              the range.
 *
 * Every range is an explicit half-open UTC [start, end) supplied by the
 * caller (no presets). The Prisma handle is injected through the
 * constructor so unit tests substitute a stub without module mocking
 * (same pattern as analytics).
 * ============================================================
 */

export type ReportsDb = Pick<
  PrismaClient,
  "order" | "orderLineItem" | "product" | "expense" | "productVariant" | "branchStock"
>;

export interface ReportRangeView {
  start: string;
  end: string;
}

export interface PnlView {
  range: ReportRangeView;
  revenue: string;
  cogs: string;
  expenses: string;
  netProfit: string;
  cogsUnpricedLineItems: number;
}

export interface CategoryTotal {
  category: string;
  count: number;
  total: string;
}

export interface ExpensesByCategoryView {
  range: ReportRangeView;
  categories: CategoryTotal[];
  grandTotal: string;
}

const SALE_STATUSES = [...SALES_STATUSES];

export class ReportsService {
  constructor(private readonly db: ReportsDb = getPrismaClient()) {}

  async getPnl(storeId: string, start: Date, end: Date): Promise<PnlView> {
    const orderWhere = {
      storeId,
      status: { in: SALE_STATUSES },
      createdAt: { gte: start, lt: end },
    };

    const [revenueAgg, lineItems, expensesAgg] = await Promise.all([
      this.db.order.aggregate({ where: orderWhere, _sum: { total: true } }),
      this.db.orderLineItem.findMany({
        where: {
          storeId,
          order: { status: { in: SALE_STATUSES }, createdAt: { gte: start, lt: end } },
        },
        select: { quantity: true, product: { select: { costPrice: true } } },
      }),
      this.db.expense.aggregate({
        where: { storeId, date: { gte: start, lt: end } },
        _sum: { amount: true },
      }),
    ]);

    let cogs = new Prisma.Decimal(0);
    let cogsUnpricedLineItems = 0;
    for (const item of lineItems) {
      const costPrice = item.product.costPrice;
      if (costPrice === null) {
        cogsUnpricedLineItems += 1;
      } else {
        cogs = cogs.add(costPrice.mul(item.quantity));
      }
    }

    const revenue = revenueAgg._sum.total ?? new Prisma.Decimal(0);
    const expenses = expensesAgg._sum.amount ?? new Prisma.Decimal(0);
    const netProfit = revenue.sub(cogs).sub(expenses);

    return {
      range: { start: start.toISOString(), end: end.toISOString() },
      revenue: revenue.toFixed(2),
      cogs: cogs.toFixed(2),
      expenses: expenses.toFixed(2),
      netProfit: netProfit.toFixed(2),
      cogsUnpricedLineItems,
    };
  }

  async getExpensesByCategory(
    storeId: string,
    start: Date,
    end: Date,
  ): Promise<ExpensesByCategoryView> {
    const grouped = await this.db.expense.groupBy({
      by: ["category"],
      where: { storeId, date: { gte: start, lt: end } },
      _sum: { amount: true },
      _count: { _all: true },
    });

    const categories = grouped
      .map((row) => ({
        category: row.category,
        count: row._count._all,
        total: (row._sum.amount ?? new Prisma.Decimal(0)).toFixed(2),
      }))
      .sort((a, b) => Number(b.total) - Number(a.total));

    const grandTotal = categories.reduce((sum, row) => sum.add(row.total), new Prisma.Decimal(0));

    return {
      range: { start: start.toISOString(), end: end.toISOString() },
      categories,
      grandTotal: grandTotal.toFixed(2),
    };
  }

  /** CSV row set for the P&L export (one data row for the range). */
  async pnlCsvRows(storeId: string, start: Date, end: Date): Promise<Record<string, string>[]> {
    const pnl = await this.getPnl(storeId, start, end);
    return [
      {
        start: pnl.range.start,
        end: pnl.range.end,
        revenue: pnl.revenue,
        cogs: pnl.cogs,
        expenses: pnl.expenses,
        netProfit: pnl.netProfit,
        cogsUnpricedLineItems: String(pnl.cogsUnpricedLineItems),
      },
    ];
  }

  /** CSV row set for the by-category export (one row per category). */
  async categoryCsvRows(storeId: string, start: Date, end: Date): Promise<Record<string, string>[]> {
    const view = await this.getExpensesByCategory(storeId, start, end);
    return view.categories.map((row) => ({
      category: row.category,
      count: String(row.count),
      total: row.total,
    }));
  }

  /**
   * Point-in-time stock valuation (dashboard-reports.md). Quantity is
   * the sellable stock: the product's cached quantity for variant-less
   * products, the summed per-variant branch stock otherwise. A null
   * costPrice contributes zero to valueAtCost and counts toward
   * unpricedProducts.
   */
  async getInventoryValuation(storeId: string): Promise<InventoryValuationView> {
    const products = await this.db.product.findMany({
      where: { storeId, deletedAt: null },
      orderBy: { name: "asc" },
      select: { id: true, name: true, sku: true, price: true, costPrice: true, quantity: true },
    });

    // Products WITH variants keep quantity at 0 — their sellable stock
    // lives per-variant in BranchStock. Only ACTIVE (non-archived) variants
    // count: a retired variant's stock is not part of the sellable
    // inventory valuation.
    const activeVariants = await this.db.productVariant.findMany({
      where: { storeId, productId: { in: products.map((product) => product.id) }, archivedAt: null },
      select: { id: true },
    });
    const variantStock = await this.db.branchStock.groupBy({
      by: ["productId"],
      where: {
        storeId,
        variantId: { in: activeVariants.map((row) => row.id) },
      },
      _sum: { quantity: true },
    });
    const variantStockByProduct = new Map(
      variantStock.map((row) => [row.productId, row._sum?.quantity ?? 0]),
    );

    let atCost = new Prisma.Decimal(0);
    let atRetail = new Prisma.Decimal(0);
    let unpricedProducts = 0;
    const items: InventoryValuationRow[] = products.map((product) => {
      const quantity = variantStockByProduct.get(product.id) ?? product.quantity;
      const valueAtRetail = new Prisma.Decimal(product.price).mul(quantity);
      if (product.costPrice === null) {
        unpricedProducts += 1;
        atRetail = atRetail.add(valueAtRetail);
        return {
          productId: product.id,
          sku: product.sku,
          name: product.name,
          quantity,
          costPrice: null,
          price: product.price.toFixed(2),
          valueAtCost: "0.00",
          valueAtRetail: valueAtRetail.toFixed(2),
        };
      }
      const valueAtCost = product.costPrice.mul(quantity);
      atCost = atCost.add(valueAtCost);
      atRetail = atRetail.add(valueAtRetail);
      return {
        productId: product.id,
        sku: product.sku,
        name: product.name,
        quantity,
        costPrice: product.costPrice.toFixed(2),
        price: product.price.toFixed(2),
        valueAtCost: valueAtCost.toFixed(2),
        valueAtRetail: valueAtRetail.toFixed(2),
      };
    });

    return {
      generatedAt: new Date(),
      items,
      totals: { atCost: atCost.toFixed(2), atRetail: atRetail.toFixed(2) },
      unpricedProducts,
    };
  }

  /** CSV rows for the valuation export (one row per product). */
  async inventoryValuationCsvRows(storeId: string): Promise<Record<string, string>[]> {
    const view = await this.getInventoryValuation(storeId);
    return view.items.map((row) => ({
      sku: row.sku ?? "",
      name: row.name,
      quantity: String(row.quantity),
      costPrice: row.costPrice ?? "",
      price: row.price,
      valueAtCost: row.valueAtCost,
      valueAtRetail: row.valueAtRetail,
    }));
  }
}

/** One product's valuation line. */
export interface InventoryValuationRow {
  productId: string;
  sku: string | null;
  name: string;
  quantity: number;
  costPrice: string | null;
  price: string;
  valueAtCost: string;
  valueAtRetail: string;
}

/** The inventory-valuation snapshot (dashboard-reports.md). */
export interface InventoryValuationView {
  generatedAt: Date;
  items: InventoryValuationRow[];
  totals: { atCost: string; atRetail: string };
  unpricedProducts: number;
}

/** Serializes report rows to CSV text (RFC 4180 via lib/csv.ts). */
export function serializeCsv(rows: Record<string, string>[]): string {
  return toCsv(rows);
}
