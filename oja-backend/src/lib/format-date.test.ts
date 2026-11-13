import { describe, expect, it } from "vitest";
import { formatHumanDate } from "./format-date.js";

describe("formatHumanDate (unit)", () => {
  it("formats a known UTC date in the shared human-readable style", () => {
    expect(formatHumanDate(new Date("2026-08-10T12:00:00Z"))).toBe("Monday, August 10, 2026");
  });

  it("is UTC-fixed: a midnight-UTC instant never rolls to the previous day", () => {
    expect(formatHumanDate(new Date("2026-08-10T00:30:00Z"))).toBe("Monday, August 10, 2026");
  });

  it("renders the far edge of the timeline without drifting", () => {
    expect(formatHumanDate(new Date("2031-01-01T00:00:00Z"))).toBe("Wednesday, January 1, 2031");
    expect(formatHumanDate(new Date("2026-08-03T23:59:59Z"))).toBe("Monday, August 3, 2026");
  });

  it("renders short month names in the expected style (en-US)", () => {
    expect(formatHumanDate(new Date("2026-02-05T00:00:00Z"))).toBe("Thursday, February 5, 2026");
  });
});
