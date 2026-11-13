import { describe, expect, it } from "vitest";
import type { MerchantBranding } from "./branding.js";
import { buildReceiptEmail, type ReceiptData } from "./email.js";

function branding(overrides: Partial<MerchantBranding> = {}): MerchantBranding {
  return {
    storeName: "Mama Ade Stores",
    logoUrl: null,
    accentColor: "#18181b",
    address: "12 Market Road, Lagos",
    phone: "+2348012345678",
    currency: "NGN",
    storefrontUrl: "https://mama-ade.example.com",
    socialLinks: { instagram: null, facebook: null, tiktok: null },
    replyTo: "owner@example.com",
    ...overrides,
  };
}

const RECEIPT: ReceiptData = {
  kind: "ORDER",
  reference: "ORD-0001",
  date: new Date("2026-09-15T10:00:00.000Z"),
  lines: [
    { name: "Palm Oil 5L", quantity: 2, unitPrice: "550.00", lineTotal: "1100.00" },
    { name: "Rice 1kg", quantity: 1, unitPrice: "150.00", lineTotal: "150.00" },
  ],
  total: "1250.00",
  amountPaid: "1250.00",
  balanceDue: "0.00",
  paymentMethod: "CASH",
};

describe("buildReceiptEmail (unit)", () => {
  it("uses the reference and store name in the subject", () => {
    const email = buildReceiptEmail(branding(), RECEIPT);
    expect(email.subject).toBe("Receipt ORD-0001 — Mama Ade Stores");
  });

  it("itemises the lines and formats totals in the store currency", () => {
    const email = buildReceiptEmail(branding(), RECEIPT);

    expect(email.html).toContain("Palm Oil 5L");
    expect(email.html).toContain("Rice 1kg");
    // 1250.00 NGN -> ₦1,250.00
    expect(email.html).toContain("₦1,250.00");
    expect(email.text).toContain("₦1,250.00");
  });

  it("escapes owner-supplied product names", () => {
    const email = buildReceiptEmail(branding(), {
      ...RECEIPT,
      lines: [{ name: "<script>alert(1)</script>", quantity: 1, unitPrice: "1.00", lineTotal: "1.00" }],
    });

    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("includes the store address, phone, and storefront link", () => {
    const email = buildReceiptEmail(branding(), RECEIPT);

    expect(email.html).toContain("12 Market Road, Lagos");
    expect(email.html).toContain("+2348012345678");
    expect(email.html).toContain("https://mama-ade.example.com");
  });

  it("includes a Powered by Brikoh footer line", () => {
    const email = buildReceiptEmail(branding(), RECEIPT);
    expect(email.html).toContain("Powered by Brikoh");
  });

  it("renders social links only when present", () => {
    const without = buildReceiptEmail(branding(), RECEIPT);
    expect(without.html).not.toContain("instagram.com");

    const withLinks = buildReceiptEmail(
      branding({
        socialLinks: {
          instagram: "https://instagram.com/mamaade",
          facebook: null,
          tiktok: null,
        },
      }),
      RECEIPT,
    );
    expect(withLinks.html).toContain("https://instagram.com/mamaade");
  });

  it("renders the amount paid and balance due", () => {
    const email = buildReceiptEmail(branding(), {
      ...RECEIPT,
      amountPaid: "1000.00",
      balanceDue: "250.00",
    });
    expect(email.html).toContain("₦1,000.00");
    expect(email.html).toContain("₦250.00");
  });
});
