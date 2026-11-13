import { describe, expect, it } from "vitest";
import { generatePaymentReference } from "./service.js";

describe("generatePaymentReference", () => {
  it("uses the BRK- prefix and is human-readable", () => {
    const ref = generatePaymentReference();
    expect(ref).toMatch(/^BRK-[A-Z0-9]{8,}$/);
  });

  it("produces unique references across calls", () => {
    const refs = new Set(Array.from({ length: 50 }, () => generatePaymentReference()));
    expect(refs.size).toBe(50);
  });
});
