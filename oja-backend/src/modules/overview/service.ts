import { Prisma } from "../../../generated/prisma/client.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { DAY_MS, SALES_STATUSES } from "../analytics/constants.js";
import { bucketOrders, compareRevenueThenNameAsc } from "../analytics/utils.js";
import { openCreditOrderWhere } from "../customers/service.js";
import { listOrders } from "../orders/service.js";

/**
 * ============================================================
 * OVERVIEW SERVICE — home-screen widgets
 * ============================================================
 * One aggregation for the dashboard home: KPI cards, a 30-day revenue
 * trend, top products, recent orders, low-stock/expiring alerts, and
 * quick counts. Money is always Decimal-toFixed(2) strings.
 *
 * Revenue visibility boundary: the endpoint is open to every tenant
 * member, but revenue-bearing fields are omitted when the caller does
 * not hold `viewProfit` (owners hold it implicitly). Aggregation still
 * happens server-side — masking is serialization-only.
 * ============================================================
 */

export const OVERVIEW_DAYS = 30;
export const RECENT_ORDERS_COUNT = 10;
export const TOP_PRODUCTS_COUNT = 5;
export const EXPIRING_WINDOW_DAYS = 7;

export interface OverviewView {
  kpis: {
    revenue?: string;
    orders: number;
    customers: number;
    avgOrderValue?: string;
  };
  revenueTrend?: {
    start: string;
    end: string;
    totalSales: string;
    orderCount: number;
  }[];
  topProducts: {
    productId: string;
    name: string;
    units: number;
    revenue?: string;
  }[];
  recentOrders: {
    id: string;
    status: string;
    paymentMethod: string | null;
    source: string;
    total: string;
    customerName: string | null;
    lineItemCount: number;
    createdAt: Date;
  }[];
  lowStock: {
    productId: string;
    name: string;
    branchId: string;
    branchName: string;
    quantity: number;
  }[];
  expiringSoon: {
    productId: string;
    name: string;
    variantId: null;
    expiryDate: Date;
    quantity: number;
  }[];
  quickStats: {
    productCount: number;
    branchCount: number;
    pendingOrderCount: number;
    creditOwing: string;
  };
}

/**
 * The full home-screen aggregation. `canViewRevenue` decides whether
 * revenue-bearing fields are included in the response (never whether
 * they are computed).
 */
export async function getOverview(storeId: string, canViewRevenue: boolean): Promise<OverviewView> {
  const prisma = getPrismaClient();

  const now = new Date();
  const windowStart = new Date(now.getTime() - OVERVIEW_DAYS * DAY_MS);

  const salesWhere: Prisma.OrderWhereInput = {
    storeId,
    status: { in: [...SALES_STATUSES] },
    createdAt: { gte: windowStart, lt: now },
  };

  const [
    salesAgg,
    customers,
    salesOrders,
    lineItems,
    pendingCount,
    creditOwing,
    productCount,
    branchCount,
    lowStockRows,
    expiringRows,
  ] = await Promise.all([
    prisma.order.aggregate({ where: salesWhere, _sum: { total: true } }),
    prisma.customer.count({ where: { storeId } }),
    prisma.order.findMany({
      where: salesWhere,
      select: { createdAt: true, total: true },
    }),
    prisma.orderLineItem.findMany({
      where: { storeId, order: salesWhere },
      select: {
        productId: true,
        quantity: true,
        unitPriceAtPurchase: true,
        product: { select: { name: true } },
      },
    }),
    prisma.order.count({ where: { storeId, status: "PENDING" } }),
    prisma.order.findMany({
      // The shared open-credit predicate (customers/service.ts): CREDIT
      // orders in a collectible status with amountPaid < total. Credit
      // repayments consume this balance automatically.
      where: openCreditOrderWhere(prisma, storeId),
      select: { total: true, amountPaid: true },
    }),
    prisma.product.count({ where: { storeId, deletedAt: null } }),
    prisma.branch.count({ where: { storeId } }),
    prisma.branchStock.findMany({
      where: { storeId },
      select: {
        quantity: true,
        branchId: true,
        branch: { select: { name: true } },
        product: {
          select: { id: true, name: true, lowStockThreshold: true },
        },
      },
    }),
    prisma.product.findMany({
      where: {
        storeId,
        deletedAt: null,
        expiryDate: {
          gte: now,
          lt: new Date(now.getTime() + EXPIRING_WINDOW_DAYS * DAY_MS),
        },
      },
      select: { id: true, name: true, expiryDate: true, quantity: true },
      orderBy: { expiryDate: "asc" },
    }),
  ]);

  const totalRevenue = salesAgg._sum?.total ?? new Prisma.Decimal(0);
  const orderCount = salesOrders.length;
  const avgOrderValue = orderCount > 0 ? totalRevenue.div(orderCount).toFixed(2) : "0.00";

  // Top products: same ranking rule as analytics best sellers (revenue
  // desc, then name asc), sliced to TOP_PRODUCTS_COUNT.
  const byProduct = new Map<string, { name: string; units: number; revenue: Prisma.Decimal }>();
  for (const item of lineItems) {
    const entry = byProduct.get(item.productId) ?? {
      name: item.product.name,
      units: 0,
      revenue: new Prisma.Decimal(0),
    };
    entry.units += item.quantity;
    entry.revenue = entry.revenue.add(item.unitPriceAtPurchase.mul(item.quantity));
    byProduct.set(item.productId, entry);
  }
  const ranked = [...byProduct.entries()]
    .map(([productId, entry]) => ({
      productId,
      name: entry.name,
      units: entry.units,
      revenue: entry.revenue,
    }))
    .sort(compareRevenueThenNameAsc)
    .slice(0, TOP_PRODUCTS_COUNT);

  // Low stock: quantity <= 0, or quantity <= the product's threshold.
  const lowStock = lowStockRows
    .filter(
      (row) =>
        row.quantity <= 0 ||
        (row.product.lowStockThreshold !== null && row.quantity <= row.product.lowStockThreshold),
    )
    .map((row) => ({
      productId: row.product.id,
      name: row.product.name,
      branchId: row.branchId,
      branchName: row.branch.name,
      quantity: row.quantity,
    }))
    .sort((a, b) => a.quantity - b.quantity);

  // Outstanding customer balances on CREDIT orders (total - amountPaid).
  const creditOwingTotal = creditOwing.reduce(
    (sum, order) => sum.add(order.total.sub(order.amountPaid ?? new Prisma.Decimal(0))),
    new Prisma.Decimal(0),
  );

  // Recent orders via the shared orders list service (any status).
  const recentPage = await listOrders(storeId, { limit: RECENT_ORDERS_COUNT });
  const recentOrders = recentPage.items.map((order) => ({
    id: order.id,
    status: order.status,
    paymentMethod: order.paymentMethod,
    source: order.source,
    total: order.total,
    customerName: order.customer?.name ?? null,
    lineItemCount: order.itemCount,
    createdAt: order.createdAt,
  }));

  const kpis = {
    orders: orderCount,
    customers,
    ...(canViewRevenue
      ? {
          revenue: totalRevenue.toFixed(2),
          avgOrderValue,
        }
      : {}),
  };

  const revenueTrend = canViewRevenue
    ? bucketOrders(salesOrders, windowStart, now, "daily")
        .reverse()
        .map((bucket) => ({
          start: bucket.start.toISOString(),
          end: bucket.end.toISOString(),
          totalSales: bucket.totalSales.toFixed(2),
          orderCount: bucket.orderCount,
        }))
    : undefined;

  const topProducts = ranked.map((entry) =>
    canViewRevenue
      ? {
          productId: entry.productId,
          name: entry.name,
          units: entry.units,
          revenue: entry.revenue.toFixed(2),
        }
      : {
          productId: entry.productId,
          name: entry.name,
          units: entry.units,
        },
  );

  return {
    kpis,
    ...(revenueTrend !== undefined ? { revenueTrend } : {}),
    topProducts,
    recentOrders,
    lowStock,
    expiringSoon: expiringRows.map((product) => ({
      productId: product.id,
      name: product.name,
      variantId: null,
      expiryDate: product.expiryDate!,
      quantity: product.quantity,
    })),
    quickStats: {
      productCount,
      branchCount,
      pendingOrderCount: pendingCount,
      creditOwing: creditOwingTotal.toFixed(2),
    },
  };
}
