import { Prisma } from "../../../generated/prisma/client.js";
import { DAY_MS, WEEK_MS, type Granularity } from "./constants.js";

/**
 * Pure analytics math — no Prisma access. Shared by every endpoint so
 * time-bucketing, percentage deltas, and ranking behave identically
 * across summary, timeseries, trends, and staff-performance.
 */

export type DecimalLike = Prisma.Decimal | number | string;

function toDecimal(value: DecimalLike): Prisma.Decimal {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

/**
 * Raw percentage difference between two monetary values, rounded to one
 * decimal: `(current - previous) / previous * 100`. Returns `null` when
 * the previous value is zero (never Infinity / NaN) — the frontend
 * renders its own placeholder for a "new" period.
 */
export function calculateChangePercent(current: DecimalLike, previous: DecimalLike): number | null {
  const c = toDecimal(current);
  const p = toDecimal(previous);
  if (p.isZero()) return null;
  return Math.round(c.sub(p).div(p).mul(100).toNumber() * 10) / 10;
}

/** 00:00:00.000 UTC on the day containing `d`. */
export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** 00:00:00.000 UTC on the Monday of the ISO week containing `d`. */
export function startOfUtcWeek(d: Date): Date {
  const day = d.getUTCDay(); // 0 = Sunday … 6 = Saturday
  const offsetToMonday = (day + 6) % 7;
  return new Date(startOfUtcDay(d).getTime() - offsetToMonday * DAY_MS);
}

export interface TimeBucket {
  start: Date;
  end: Date;
}

/**
 * Generates every UTC bucket intersecting the half-open range [start, end):
 * daily buckets aligned to UTC midnight, weekly buckets aligned to Monday
 * 00:00 UTC (ISO weeks). Empty buckets are included by the caller via
 * zero-filling — this function returns the boundaries for the whole range.
 */
export function buildTimeBuckets(start: Date, end: Date, granularity: Granularity): TimeBucket[] {
  const buckets: TimeBucket[] = [];
  if (end.getTime() <= start.getTime()) return buckets;

  const step = granularity === "daily" ? DAY_MS : WEEK_MS;
  const anchor = (d: Date) => (granularity === "daily" ? startOfUtcDay(d) : startOfUtcWeek(d));
  let cursor = anchor(start).getTime();
  while (cursor < end.getTime()) {
    buckets.push({ start: new Date(cursor), end: new Date(cursor + step) });
    cursor += step;
  }
  return buckets;
}

export interface BucketOrder {
  createdAt: Date;
  total: Prisma.Decimal;
}

export interface BucketTotals {
  /** UTC bucket boundaries (mirror of the buildTimeBuckets entry). */
  start: Date;
  end: Date;
  totalSales: Prisma.Decimal;
  orderCount: number;
}

/**
 * Assigns orders to the UTC buckets of the range and sums each bucket.
 * Orders outside the half-open range are ignored defensively (callers
 * already filter in SQL). Result length always matches
 * `buildTimeBuckets(...)` — every bucket appears, zero-filled, and each
 * entry carries its UTC start/end for serialization.
 */
export function bucketOrders(
  orders: readonly BucketOrder[],
  rangeStart: Date,
  rangeEnd: Date,
  granularity: Granularity,
): BucketTotals[] {
  const buckets = buildTimeBuckets(rangeStart, rangeEnd, granularity);
  const totals: BucketTotals[] = buckets.map((bucket) => ({
    start: bucket.start,
    end: bucket.end,
    totalSales: new Prisma.Decimal(0),
    orderCount: 0,
  }));
  const step = granularity === "daily" ? DAY_MS : WEEK_MS;
  const anchor = (d: Date) => (granularity === "daily" ? startOfUtcDay(d) : startOfUtcWeek(d));
  const anchor0 = buckets[0]?.start.getTime() ?? 0;

  for (const order of orders) {
    if (order.createdAt.getTime() < rangeStart.getTime()) continue;
    if (order.createdAt.getTime() >= rangeEnd.getTime()) continue;
    const index = Math.floor((anchor(order.createdAt).getTime() - anchor0) / step);
    const target = totals[index];
    if (target === undefined) continue;
    target.totalSales = target.totalSales.add(order.total);
    target.orderCount += 1;
  }
  return totals;
}

/**
 * Deterministic ranking: revenue descending, then name ascending
 * (case-sensitive locale compare). Used by best sellers and by the
 * staff leaderboard so the ordering rule lives in exactly one place.
 */
export function compareRevenueThenNameAsc(
  a: { revenue: Prisma.Decimal; name: string },
  b: { revenue: Prisma.Decimal; name: string },
): number {
  const byRevenue = b.revenue.cmp(a.revenue);
  if (byRevenue !== 0) return byRevenue;
  return a.name.localeCompare(b.name);
}
