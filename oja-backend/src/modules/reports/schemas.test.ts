import { describe, expect, it } from "vitest";
import { parseReportRange } from "./schemas.js";

describe("parseReportRange (unit)", () => {
  it("returns Date boundaries for a valid UTC range", () => {
    const range = parseReportRange({
      start: "2026-08-01T00:00:00.000Z",
      end: "2026-09-01T00:00:00.000Z",
    });
    expect(range.start.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("accepts a +00:00 offset", () => {
    const range = parseReportRange({
      start: "2026-08-01T00:00:00+00:00",
      end: "2026-08-02T00:00:00+00:00",
    });
    expect(range.start.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("rejects a missing start or end with a clear message", () => {
    try {
      parseReportRange({ end: "2026-09-01T00:00:00.000Z" });
      throw new Error("unreachable");
    } catch (err) {
      expect(err).toMatchObject({ statusCode: 400, code: "INVALID_RANGE" });
      expect((err as { message: string }).message).toMatch(/start and end date/i);
    }
  });

  it("rejects a non-UTC offset", () => {
    expect(() =>
      parseReportRange({ start: "2026-08-01T00:00:00+01:00", end: "2026-09-01T00:00:00Z" }),
    ).toThrow(/UTC/);
  });

  it("rejects a malformed date", () => {
    expect(() => parseReportRange({ start: "not-a-date", end: "2026-09-01T00:00:00Z" })).toThrow(
      /valid date/i,
    );
  });

  it("rejects start >= end with a clear message", () => {
    expect(() =>
      parseReportRange({ start: "2026-09-01T00:00:00Z", end: "2026-08-01T00:00:00Z" }),
    ).toThrow(/before the end date/i);
    expect(() =>
      parseReportRange({ start: "2026-08-01T00:00:00Z", end: "2026-08-01T00:00:00Z" }),
    ).toThrow(/before the end date/i);
  });

  it("always tags range failures with the INVALID_RANGE code", () => {
    try {
      parseReportRange({ start: "2026-09-01T00:00:00Z", end: "2026-08-01T00:00:00Z" });
      throw new Error("unreachable");
    } catch (err) {
      expect(err).toMatchObject({ statusCode: 400, code: "INVALID_RANGE" });
    }
  });
});
