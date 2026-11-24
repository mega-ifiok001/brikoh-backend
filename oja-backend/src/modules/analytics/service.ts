import { Prisma, type $Enums, type PrismaClient } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { resolvePlan } from "../subscriptions/plan.js";
import { CHANNELS, DEFAULT_TOP, SALES_STATUSES, type Granularity } from "./constants.js";
import {
  bucketOrders,
  calculateChangePercent,
  compareRevenueThenNameAsc,
  type BucketOrder,
  type BucketTotals,
} from "./utils.js";

/**
 * ============================================================
 * ANALYTICS SERVICE
 * ============================================================
 *
 * Every Prisma aggregate and read for analytics lives in this class —
 * controllers never touch the database. Add new KPIs as methods here;
 * the shared constants (SALES_STATUSES) and pure math (time buckets,
 * change percent, ranking) come from ./constants.ts and ./utils.ts so
 * every endpoint behaves identically.
 *
 * The Prisma handle is injected through the constructor (defaulting to
 * the shared client) so unit tests substitute a stub without module
 * mocking.
 * ============================================================
 */

export type AnalyticsDb = Pick<
  PrismaClient,
  "order" | "orderLineItem" | "stockLedgerEntry" | "staffMember" | "store" | "subscription"
>;

export interface AnalyticsRange {
  start: Date;
  end: Date;
}

export interface SalesSummary {
  date: string;
  totalSales: string;
  orderCount: number;
  bestSellers: { productId: string; name: string; units: number; revenue: string }[];
}

export interface BucketDto {
  date: string;
  totalSales: string;
  orderCount: number;
}

export interface TimeseriesView {
  date: string;
  granularity: Granularity;
  buckets: BucketDto[];
}

export interface SalesTrendsView extends TimeseriesView {
  totals: { totalSales: string; orderCount: number };
  previousPeriod: { date: string; totalSales: string; orderCount: number };
  changePercent: number | null;
}

export interface StaffPerformanceRow {
  staffMemberId: string;
  name: string;
  sales: { orderCount: number; revenue: string };
  inventoryActivity: { entries: number; unitsAdjusted: number };
}

export interface StaffPerformanceView {
  date: string;
  staff: StaffPerformanceRow[];
}

export interface ChannelRow {
  source: $Enums.OrderSource;
  orderCount: number;
  revenue: string;
}

export interface ChannelsView {
  date: string;
  channels: ChannelRow[];
}

function salesWhere(storeId: string, range: AnalyticsRange) {
  return {
    storeId,
    status: { in: [...SALES_STATUSES] },
    createdAt: { gte: range.start, lt: range.end },
  };
}

function serializeDate(range: AnalyticsRange): string {
  return range.start.toISOString().slice(0, 10);
}

function serializeBuckets(buckets: readonly BucketTotals[]): BucketDto[] {
  return buckets.map((bucket) => ({
    date: bucket.start.toISOString().slice(0, 10),
    totalSales: bucket.totalSales.toFixed(2),
    orderCount: bucket.orderCount,
  }));
}

function sumOrders(orders: readonly BucketOrder[]): Prisma.Decimal {
  return orders.reduce((sum, order) => sum.add(order.total), new Prisma.Decimal(0));
}

export class AnalyticsService {
  constructor(private readonly db: AnalyticsDb = getPrismaClient()) {}

  /** Total sales and best-selling products over the range (all tiers). */
  async getSalesSummary(
    storeId: string,
    range: AnalyticsRange,
    top: number = DEFAULT_TOP,
  ): Promise<SalesSummary> {
    const where = salesWhere(storeId, range);
    const [agg, orderCount, lineItems] = await Promise.all([
      this.db.order.aggregate({ where, _sum: { total: true } }),
      this.db.order.count({ where }),
      this.db.orderLineItem.findMany({
        where: { storeId, order: where },
        select: {
          productId: true,
          quantity: true,
          unitPriceAtPurchase: true,
          product: { select: { name: true } },
        },
      }),
    ]);

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

    const bestSellers = [...byProduct.entries()]
      .map(([productId, entry]) => ({
        productId,
        name: entry.name,
        units: entry.units,
        revenue: entry.revenue,
      }))
      .sort(compareRevenueThenNameAsc)
      .slice(0, top)
      .map((entry) => ({ ...entry, revenue: entry.revenue.toFixed(2) }));

    return {
      date: serializeDate(range),
      totalSales: (agg._sum.total ?? new Prisma.Decimal(0)).toFixed(2),
      orderCount,
      bestSellers,
    };
  }

  /** Daily or weekly total-sales buckets, zero-filled (all tiers). */
  async getTimeseries(
    storeId: string,
    range: AnalyticsRange,
    granularity: Granularity,
  ): Promise<TimeseriesView> {
    const orders = await this.db.order.findMany({
      where: salesWhere(storeId, range),
      select: { createdAt: true, total: true },
    });

    return {
      date: serializeDate(range),
      granularity,
      buckets: serializeBuckets(bucketOrders(orders, range.start, range.end, granularity)),
    };
  }

  /** Sales trends with an equally sized preceding window (advanced). */
  async getSalesTrends(
    storeId: string,
    range: AnalyticsRange,
    granularity: Granularity,
  ): Promise<SalesTrendsView> {
    await this.requireAdvancedAccess(storeId);

    const span = range.end.getTime() - range.start.getTime();
    const previousStart = new Date(range.start.getTime() - span);
    const previousEnd = range.start;

    const [currentOrders, previousOrders] = await Promise.all([
      this.db.order.findMany({
        where: salesWhere(storeId, range),
        select: { createdAt: true, total: true },
      }),
      this.db.order.findMany({
        where: salesWhere(storeId, { start: previousStart, end: previousEnd }),
        select: { createdAt: true, total: true },
      }),
    ]);

    const currentTotal = sumOrders(currentOrders);
    const previousTotal = sumOrders(previousOrders);

    return {
      date: serializeDate(range),
      granularity,
      totals: { totalSales: currentTotal.toFixed(2), orderCount: currentOrders.length },
      previousPeriod: {
        date: previousStart.toISOString().slice(0, 10),
        totalSales: previousTotal.toFixed(2),
        orderCount: previousOrders.length,
      },
      changePercent: calculateChangePercent(currentTotal, previousTotal),
      buckets: serializeBuckets(bucketOrders(currentOrders, range.start, range.end, granularity)),
    };
  }

  /**
   * Per-staff leaderboard across two independent attribution domains:
   * sales revenue (Order.soldByStaffId) and inventory activity
   * (StockLedgerEntry.performedByStaffId). A member in either domain
   * appears once; ranked by revenue desc, then name asc.
   */
  async getStaffPerformance(storeId: string, range: AnalyticsRange): Promise<StaffPerformanceView> {
    await this.requireAdvancedAccess(storeId);

    const [salesGroups, activityGroups] = await Promise.all([
      this.db.order.groupBy({
        by: ["soldByStaffId"],
        where: {
          storeId,
          soldByStaffId: { not: null },
          status: { in: [...SALES_STATUSES] },
          createdAt: { gte: range.start, lt: range.end },
        },
        _count: true,
        _sum: { total: true },
      }),
      this.db.stockLedgerEntry.groupBy({
        by: ["performedByStaffId"],
        where: {
          storeId,
          performedByStaffId: { not: null },
          createdAt: { gte: range.start, lt: range.end },
        },
        _count: true,
        _sum: { quantityChange: true },
      }),
    ]);

    const salesByStaff = new Map(
      salesGroups.map((group) => [
        group.soldByStaffId!,
        {
          orderCount: group._count,
          revenue: group._sum.total ?? new Prisma.Decimal(0),
        },
      ]),
    );
    const activityByStaff = new Map(
      activityGroups.map((group) => [
        group.performedByStaffId!,
        { entries: group._count, unitsAdjusted: group._sum.quantityChange ?? 0 },
      ]),
    );

    const ids = [...new Set([...salesByStaff.keys(), ...activityByStaff.keys()])];
    const names = new Map<string, string>();
    if (ids.length > 0) {
      const staffRows = await this.db.staffMember.findMany({
        where: { id: { in: ids }, storeId },
        select: { id: true, account: { select: { firstName: true, lastName: true } } },
      });
      for (const row of staffRows) {
        const fullName = [row.account.firstName, row.account.lastName]
          .filter((part): part is string => Boolean(part))
          .join(" ");
        names.set(row.id, fullName || "—");
      }
    }

    const staff = ids
      .map((id) => {
        const sales = salesByStaff.get(id);
        const activity = activityByStaff.get(id);
        return {
          staffMemberId: id,
          name: names.get(id) ?? "—",
          sales: {
            orderCount: sales?.orderCount ?? 0,
            revenue: (sales?.revenue ?? new Prisma.Decimal(0)).toFixed(2),
          },
          inventoryActivity: {
            entries: activity?.entries ?? 0,
            unitsAdjusted: activity?.unitsAdjusted ?? 0,
          },
        };
      })
      .sort((a, b) =>
        compareRevenueThenNameAsc(
          { revenue: new Prisma.Decimal(a.sales.revenue), name: a.name },
          { revenue: new Prisma.Decimal(b.sales.revenue), name: b.name },
        ),
      );

    return { date: serializeDate(range), staff };
  }

  /** Revenue-by-channel breakdown over successful sales (advanced tier). */
  async getChannels(storeId: string, range: AnalyticsRange): Promise<ChannelsView> {
    await this.requireAdvancedAccess(storeId);

    const groups = await this.db.order.groupBy({
      by: ["source"],
      where: { ...salesWhere(storeId, range) },
      _count: true,
      _sum: { total: true },
    });
    const bySource = new Map(
      groups.map((group) => [
        group.source,
        { orderCount: group._count, revenue: group._sum.total },
      ]),
    );

    return {
      date: serializeDate(range),
      channels: CHANNELS.map((source) => {
        const group = bySource.get(source);
        return {
          source,
          orderCount: group?.orderCount ?? 0,
          revenue: (group?.revenue ?? new Prisma.Decimal(0)).toFixed(2),
        };
      }),
    };
  }

  /**
   * Advanced-analytics gate, shared by trends and staff-performance:
   * an active subscription is required, then the tier's
   * `advancedAnalytics` feature flag. Mirrors the custom-domain gate
   * ordering (subscription first, flag second).
   */
  private async requireAdvancedAccess(storeId: string): Promise<void> {
    const store = await this.db.store.findUnique({
      where: { id: storeId },
      select: { subscriptionId: true },
    });
    if (store === null || store.subscriptionId === null) {
      throw new AppError(
        403,
        "SUBSCRIPTION_INACTIVE",
        "This store has no active subscription — choose a plan to view advanced analytics",
      );
    }

    const subscription = await this.db.subscription.findUnique({
      where: { id: store.subscriptionId },
    });
    if (subscription === null) {
      throw new AppError(
        403,
        "SUBSCRIPTION_INACTIVE",
        "This store has no active subscription — choose a plan to view advanced analytics",
      );
    }

    const plan = resolvePlan(subscription);
    if (!plan.active) {
      throw new AppError(
        403,
        "SUBSCRIPTION_INACTIVE",
        `Your subscription is ${subscription.status}; reactivate to view advanced analytics`,
      );
    }
    if (!plan.featureFlags.advancedAnalytics) {
      const upgrade =
        plan.tier === "STARTER" ? "upgrade to PRO" : "contact us for access to this feature";
      throw new AppError(
        403,
        "ADVANCED_ANALYTICS_REQUIRED",
        `Advanced analytics are not included in your ${plan.tier} plan — ${upgrade} to view them`,
      );
    }
  }
}
