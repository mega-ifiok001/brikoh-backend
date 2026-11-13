import { describe, expect, it } from "vitest";
import { Prisma } from "../../../generated/prisma/client.js";
import {
  calculateChangePercent,
  startOfUtcDay,
  startOfUtcWeek,
  buildTimeBuckets,
  bucketOrders,
  compareRevenueThenNameAsc,
} from "./utils.js";

const D = (v: string) => new Prisma.Decimal(v);

describe("calculateChangePercent", () => {
  it("returns the raw percentage difference", () => {
    expect(calculateChangePercent("65.50", "20.00")).toBe(227.5);
    expect(calculateChangePercent("50", "100")).toBe(-50);
    expect(calculateChangePercent("1", "3")).toBe(-66.7);
    expect(calculateChangePercent("10", "10")).toBe(0);
  });

  it("accepts Prisma.Decimal inputs", () => {
    expect(calculateChangePercent(D("15.00"), D("10.00"))).toBe(50);
  });

  it("returns null (never Infinity) when the previous period is zero", () => {
    expect(calculateChangePercent("50", "0")).toBeNull();
    expect(calculateChangePercent("0", "0")).toBeNull();
    expect(calculateChangePercent(D("0.00"), D("0.00"))).toBeNull();
  });
});

describe("startOfUtcDay / startOfUtcWeek", () => {
  it("truncates to UTC midnight", () => {
    expect(startOfUtcDay(new Date("2026-08-05T23:59:59.999Z"))).toEqual(
      new Date("2026-08-05T00:00:00.000Z"),
    );
    expect(startOfUtcDay(new Date("2026-08-05T00:00:01.000Z"))).toEqual(
      new Date("2026-08-05T00:00:00.000Z"),
    );
  });

  it("backs up to the preceding Monday 00:00 UTC", () => {
    // Wed 2026-08-05 -> Mon 2026-08-03
    expect(startOfUtcWeek(new Date("2026-08-05T12:34:56.000Z"))).toEqual(
      new Date("2026-08-03T00:00:00.000Z"),
    );
    // Sun 2026-08-09 -> Mon 2026-08-03
    expect(startOfUtcWeek(new Date("2026-08-09T23:59:59.000Z"))).toEqual(
      new Date("2026-08-03T00:00:00.000Z"),
    );
    // Monday itself stays put
    expect(startOfUtcWeek(new Date("2026-08-03T00:00:00.000Z"))).toEqual(
      new Date("2026-08-03T00:00:00.000Z"),
    );
  });
});

describe("buildTimeBuckets", () => {
  const start = new Date("2026-08-03T00:00:00.000Z");
  const end = new Date("2026-08-07T00:00:00.000Z");

  it("builds one zero-carrying bucket per UTC day in range (daily)", () => {
    const buckets = buildTimeBuckets(start, end, "daily");
    expect(buckets).toHaveLength(4);
    expect(buckets[0]).toEqual({
      start: new Date("2026-08-03T00:00:00.000Z"),
      end: new Date("2026-08-04T00:00:00.000Z"),
    });
    expect(buckets[3]).toEqual({
      start: new Date("2026-08-06T00:00:00.000Z"),
      end: new Date("2026-08-07T00:00:00.000Z"),
    });
  });

  it("builds Monday-aligned ISO weeks (weekly)", () => {
    const buckets = buildTimeBuckets(
      new Date("2026-08-05T00:00:00.000Z"),
      new Date("2026-08-08T00:00:00.000Z"),
      "weekly",
    );
    expect(buckets).toEqual([
      {
        start: new Date("2026-08-03T00:00:00.000Z"),
        end: new Date("2026-08-10T00:00:00.000Z"),
      },
    ]);
  });

  it("covers the day containing the range end when the end is mid-day", () => {
    // end 2026-08-07T00:30Z intersects the Aug-07 bucket, so it is included
    const buckets = buildTimeBuckets(
      new Date("2026-08-05T23:30:00.000Z"),
      new Date("2026-08-07T00:30:00.000Z"),
      "daily",
    );
    expect(buckets).toHaveLength(3);
    expect(buckets.map((b) => b.start)).toEqual([
      new Date("2026-08-05T00:00:00.000Z"),
      new Date("2026-08-06T00:00:00.000Z"),
      new Date("2026-08-07T00:00:00.000Z"),
    ]);
  });
});

describe("bucketOrders", () => {
  it("assigns orders to their UTC day, respecting the half-open range", () => {
    const results = bucketOrders(
      [
        { createdAt: new Date("2026-08-03T09:30:00.000Z"), total: D("25.00") },
        { createdAt: new Date("2026-08-03T23:59:59.000Z"), total: D("7.00") },
        { createdAt: new Date("2026-08-03T00:00:00.000Z"), total: D("3.50") },
        { createdAt: new Date("2026-08-05T00:00:00.000Z"), total: D("20.00") },
        { createdAt: new Date("2026-08-05T00:00:01.000Z"), total: D("10.00") },
        // at/outside the range:
        { createdAt: new Date("2026-08-07T00:00:00.000Z"), total: D("99.00") }, // == end
        { createdAt: new Date("2026-08-02T23:59:59.000Z"), total: D("88.00") }, // < start
      ],
      new Date("2026-08-03T00:00:00.000Z"),
      new Date("2026-08-07T00:00:00.000Z"),
      "daily",
    );

    expect(results.map((b) => b.orderCount)).toEqual([3, 0, 2, 0]);
    expect(results.map((b) => b.totalSales.toString())).toEqual(["35.5", "0", "30", "0"]);
  });

  it("separates orders straddling a UTC midnight across buckets", () => {
    const results = bucketOrders(
      [
        { createdAt: new Date("2026-08-05T23:59:59.000Z"), total: D("10.00") },
        { createdAt: new Date("2026-08-06T00:00:01.000Z"), total: D("13.50") },
      ],
      new Date("2026-08-05T23:30:00.000Z"),
      new Date("2026-08-06T00:30:00.000Z"),
      "daily",
    );
    expect(results.map((b) => b.orderCount)).toEqual([1, 1]);
    expect(results.map((b) => b.totalSales.toString())).toEqual(["10", "13.5"]);
  });

  it("buckets by UTC week when granularity is weekly", () => {
    const results = bucketOrders(
      [
        { createdAt: new Date("2026-08-03T09:30:00.000Z"), total: D("30.00") },
        { createdAt: new Date("2026-08-06T22:00:00.000Z"), total: D("35.50") },
      ],
      new Date("2026-08-03T00:00:00.000Z"),
      new Date("2026-08-07T00:00:00.000Z"),
      "weekly",
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.orderCount).toBe(2);
    expect(results[0]!.totalSales.toString()).toBe("65.5");
  });
});

describe("compareRevenueThenNameAsc", () => {
  it("sorts by revenue descending, then name ascending", () => {
    const rows = [
      { revenue: D("5.00"), name: "A" },
      { revenue: D("45.00"), name: "Zed" },
      { revenue: D("10.00"), name: "Bob" },
      { revenue: D("10.00"), name: "Alice" },
    ];
    const sorted = [...rows].sort(compareRevenueThenNameAsc);
    expect(sorted.map((r) => `${r.name}:${r.revenue.toFixed(2)}`)).toEqual([
      "Zed:45.00",
      "Alice:10.00",
      "Bob:10.00",
      "A:5.00",
    ]);
  });
});
