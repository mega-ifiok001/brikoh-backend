import { describe, expect, it } from "vitest";
import { computeFunnel, medianFirstOrderSeconds } from "./telemetry.js";

const t = (value: string) => new Date(value);

describe("telemetry funnel (RED)", () => {
  it("counts sequential real milestones with previous-step conversions", () => {
    const result = computeFunnel([
      {
        createdAt: t("2026-08-01T00:00:00Z"),
        publishedAt: t("2026-08-02T00:00:00Z"),
        orderedAt: t("2026-08-03T00:00:00Z"),
        paidAt: t("2026-08-04T00:00:00Z"),
        upgradedAt: t("2026-08-05T00:00:00Z"),
      },
      {
        createdAt: t("2026-08-01T00:00:00Z"),
        publishedAt: t("2026-08-02T00:00:00Z"),
        orderedAt: t("2026-08-03T00:00:00Z"),
        paidAt: null,
        upgradedAt: null,
      },
      {
        createdAt: t("2026-08-01T00:00:00Z"),
        publishedAt: null,
        orderedAt: null,
        paidAt: null,
        upgradedAt: null,
      },
      {
        createdAt: t("2026-08-01T00:00:00Z"),
        publishedAt: null,
        orderedAt: null,
        paidAt: t("2026-08-02T00:00:00Z"),
        upgradedAt: null,
      },
    ]);
    expect(result).toEqual([
      { key: "registered", count: 4, conversionFromPrevious: 100 },
      { key: "firstProductPublished", count: 2, conversionFromPrevious: 50 },
      { key: "firstOrderPlaced", count: 2, conversionFromPrevious: 100 },
      { key: "firstOrderPaid", count: 1, conversionFromPrevious: 50 },
      { key: "upgradedToPaidTier", count: 1, conversionFromPrevious: 100 },
    ]);
  });

  it("returns null conversions after zero and exact odd/even medians", () => {
    expect(
      computeFunnel([
        {
          createdAt: t("2026-08-01T00:00:00Z"),
          publishedAt: null,
          orderedAt: null,
          paidAt: null,
          upgradedAt: null,
        },
      ])[2]!.conversionFromPrevious,
    ).toBeNull();
    expect(medianFirstOrderSeconds([10, 30, 20])).toBe(20);
    expect(medianFirstOrderSeconds([10, 30])).toBe(20);
    expect(medianFirstOrderSeconds([])).toBeNull();
  });
});
