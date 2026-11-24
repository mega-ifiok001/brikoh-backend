import { describe, expect, it } from "vitest";
import { validateTransactionExportQuery, validateTransactionQuery } from "./schemas.js";

describe("transaction query schemas", () => {
  it("loads the export schema and accepts date range filters", () => {
    expect(
      validateTransactionExportQuery({ from: "2026-11-01", to: "2026-11-24", view: "all" }),
    ).toMatchObject({ from: "2026-11-01", to: "2026-11-24", view: "all" });
  });

  it("defaults the feed pagination and validates the inclusive range", () => {
    expect(validateTransactionQuery({ from: "2026-11-24", to: "2026-11-24" })).toMatchObject({
      from: "2026-11-24",
      to: "2026-11-24",
      view: "all",
      limit: 50,
    });
  });

  it("rejects ranges longer than the supported maximum", () => {
    try {
      validateTransactionExportQuery({ from: "2025-01-01", to: "2026-01-03" });
      throw new Error("unreachable");
    } catch (err) {
      expect(err).toMatchObject({ statusCode: 400, code: "INVALID_TRANSACTION_FILTER" });
      expect((err as { internalDetail: string }).internalDetail).toMatch(/367 calendar days/i);
    }
  });
});
