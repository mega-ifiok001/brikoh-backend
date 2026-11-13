import { describe, expect, it } from "vitest";
import { parseDurationToMs } from "./duration.js";

describe("parseDurationToMs (unit)", () => {
  it("parses seconds, minutes, hours, and days", () => {
    expect(parseDurationToMs("30s")).toBe(30_000);
    expect(parseDurationToMs("15m")).toBe(900_000);
    expect(parseDurationToMs("1h")).toBe(3_600_000);
    expect(parseDurationToMs("7d")).toBe(604_800_000);
  });

  it("rejects malformed durations", () => {
    expect(() => parseDurationToMs("15")).toThrow();
    expect(() => parseDurationToMs("15x")).toThrow();
    expect(() => parseDurationToMs("")).toThrow();
    expect(() => parseDurationToMs("-1d")).toThrow();
  });
});
