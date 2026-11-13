import { describe, expect, it } from "vitest";
import { formatMoney } from "./format-currency.js";

describe("formatMoney (unit)", () => {
  it("formats NGN with the naira symbol, thousands separators, and 2dp", () => {
    expect(formatMoney("4900.00", "NGN")).toBe("₦4,900.00");
    expect(formatMoney("1234567.5", "NGN")).toBe("₦1,234,567.50");
    expect(formatMoney("0.00", "NGN")).toBe("₦0.00");
  });

  it("formats USD with the dollar sign", () => {
    expect(formatMoney("1234.56", "USD")).toBe("$1,234.56");
  });

  it("formats the other supported currencies", () => {
    expect(formatMoney("100.00", "GHS")).toBe("GH₵100.00");
    expect(formatMoney("100.00", "KES")).toBe("KSh100.00");
    expect(formatMoney("100.00", "ZAR")).toBe("R100.00");
  });

  it("normalizes a bare integer string to 2dp", () => {
    expect(formatMoney("4900", "NGN")).toBe("₦4,900.00");
  });
});
