import { describe, expect, it } from "vitest";
import {
  ACTIVATION_WINDOW_MS,
  CHURNED_STATUSES,
  computeActivationRate,
  computeChurnRate,
  countEventsByUtcBucket,
} from "./lifecycle.js";

/**
 * The churn and activation definitions are CENTRAL facts shared by the
 * merchant dashboards and the admin health endpoints. Changing a metric
 * means changing lifecycle.ts once — these tests pin the definitions.
 */

describe("lifecycle constants", () => {
  it("defines churned as non-active terminal statuses (CANCELLED today, EXPIRED joins later)", () => {
    expect(CHURNED_STATUSES).toEqual(["CANCELLED"]);
    expect(CHURNED_STATUSES).not.toContain("ACTIVE");
    expect(CHURNED_STATUSES).not.toContain("TRIALING");
  });

  it("pins the activation window to 24 hours", () => {
    expect(ACTIVATION_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("computeChurnRate (official definition)", () => {
  it("returns percent rounded to one decimal (happy path)", () => {
    expect(computeChurnRate(2, 20)).toBe(10);
    expect(computeChurnRate(5, 2)).toBe(250);
    expect(computeChurnRate(1, 3)).toBe(33.3);
  });

  it("returns 0 when nothing churned", () => {
    expect(computeChurnRate(0, 50)).toBe(0);
  });

  it("returns null when there is no baseline (edge case)", () => {
    expect(computeChurnRate(0, 0)).toBeNull();
    expect(computeChurnRate(3, 0)).toBeNull();
  });

  it("returns null for negative inputs (defensive edge)", () => {
    expect(computeChurnRate(-1, 10)).toBeNull();
    expect(computeChurnRate(1, -10)).toBeNull();
  });
});

describe("computeActivationRate (operational proxy)", () => {
  it("returns percent (activated / created) (happy path)", () => {
    expect(computeActivationRate(6, 10)).toBe(60);
    expect(computeActivationRate(4, 5)).toBe(80);
    expect(computeActivationRate(1, 3)).toBe(33.3);
  });

  it("returns 0 when nothing activated", () => {
    expect(computeActivationRate(0, 8)).toBe(0);
  });

  it("returns null when no stores were created (edge case)", () => {
    expect(computeActivationRate(0, 0)).toBeNull();
  });
});

describe("countEventsByUtcBucket", () => {
  const start = new Date("2026-08-03T00:00:00.000Z");
  const end = new Date("2026-08-06T00:00:00.000Z");

  it("counts events into zero-filled daily UTC buckets (happy path)", () => {
    const buckets = countEventsByUtcBucket(
      [
        { createdAt: new Date("2026-08-03T10:00:00.000Z") },
        { createdAt: new Date("2026-08-03T23:59:59.000Z") },
        { createdAt: new Date("2026-08-05T00:00:00.000Z") },
      ],
      start,
      end,
      "daily",
    );
    expect(buckets).toEqual([
      { start: "2026-08-03T00:00:00.000Z", end: "2026-08-04T00:00:00.000Z", count: 2 },
      { start: "2026-08-04T00:00:00.000Z", end: "2026-08-05T00:00:00.000Z", count: 0 },
      { start: "2026-08-05T00:00:00.000Z", end: "2026-08-06T00:00:00.000Z", count: 1 },
    ]);
  });

  it("excludes events outside the half-open range (edge case)", () => {
    const buckets = countEventsByUtcBucket(
      [
        { createdAt: new Date("2026-08-02T23:59:59.000Z") }, // before start
        { createdAt: new Date("2026-08-06T00:00:00.000Z") }, // exactly at end
      ],
      start,
      end,
      "daily",
    );
    expect(buckets.every((b) => b.count === 0)).toBe(true);
  });

  it("returns an empty list for an empty range (edge case)", () => {
    expect(countEventsByUtcBucket([], end, start, "daily")).toEqual([]);
  });

  it("groups by ISO week when granularity is weekly", () => {
    // 2026-08-03 is a Monday; 2026-08-17 is also a Monday.
    const buckets = countEventsByUtcBucket(
      [{ createdAt: new Date("2026-08-11T00:00:00.000Z") }],
      new Date("2026-08-03T00:00:00.000Z"),
      new Date("2026-08-24T00:00:00.000Z"),
      "weekly",
    );
    expect(buckets.map((b) => b.count)).toEqual([0, 1, 0]);
  });
});
