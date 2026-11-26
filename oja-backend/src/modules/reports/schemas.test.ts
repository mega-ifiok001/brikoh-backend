import { describe, expect, it } from "vitest";
import { parseReportRange } from "./schemas.js";

describe("parseReportRange (unit)", () => {
  it("returns UTC boundaries for the selected date", () => {
    const range = parseReportRange({ date: "2026-08-01" });
    expect(range.date).toBe("2026-08-01");
    expect(range.start.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-08-02T00:00:00.000Z");
  });

  it("rejects a missing date with a clear message", () => {
    expect(() => parseReportRange({})).toThrow(/provide a date/i);
  });

  it("rejects interval parameters", () => {
    expect(() => parseReportRange({ start: "2026-08-01", end: "2026-08-02" })).toThrow(
      /only the date query parameter/i,
    );
  });

  it("rejects a malformed or impossible calendar date", () => {
    expect(() => parseReportRange({ date: "not-a-date" })).toThrow(/YYYY-MM-DD/i);
    expect(() => parseReportRange({ date: "2026-02-30" })).toThrow(/valid calendar date/i);
  });

  it("always tags invalid selections with the INVALID_RANGE code", () => {
    try {
      parseReportRange({ date: "2026-02-30" });
      throw new Error("unreachable");
    } catch (err) {
      expect(err).toMatchObject({ statusCode: 400, code: "INVALID_RANGE" });
    }
  });
});
